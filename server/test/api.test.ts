import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { type MarketData, MarketDataError, type MarketDataErrorKind } from "../src/data/marketdata.js";
import type { InstrumentSearch, SearchHit } from "../src/data/search.js";
import { AAPL, D0, D1, H, SAP, makeSource } from "./fakes.js";

const NOW = D0 + 5 * 86400;
const START = D0 + 7 * H + 600; // 07:10 UTC on D0, SAP is trading

const open: FastifyInstance[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function make(opts: { fail?: MarketDataErrorKind; now?: number } = {}) {
  const { source } = makeSource(opts);
  const app = buildApp({
    dbPath: ":memory:", marketData: source, instruments: [SAP, AAPL], now: () => opts.now ?? NOW, minGapMs: 0, tickMs: 20,
  });
  open.push(app);
  return app;
}

const post = (app: FastifyInstance, url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

async function createSim(app: FastifyInstance, startAt = START) {
  const res = await post(app, "/api/simulations", { name: "T", startAt });
  expect(res.statusCode).toBe(201);
  return res.json().id as number;
}

const until = async (cond: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function connect(app: FastifyInstance, id: number) {
  await app.ready(); // injectWS exists only once the app is ready
  const msgs: any[] = [];
  const ws = await app.injectWS(`/ws/simulations/${id}`, {}, {
    onInit: (w: any) => w.on("message", (d: Buffer) => msgs.push(JSON.parse(String(d)))),
  });
  return { ws, msgs, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe("simulations", () => {
  it("lists the watchlist, with the starting list marked as not added", async () => {
    const res = await make().inject({ url: "/api/watchlist" });
    expect(res.json()).toEqual([
      { symbol: "SAP.DE", name: "SAP", currency: "EUR", venue: "XETRA", added: false },
      { symbol: "AAPL", name: "Apple", currency: "USD", venue: "US", added: false },
    ]);
  });

  it("creates, lists and deletes a simulation", async () => {
    const app = make();
    const res = await post(app, "/api/simulations", { name: "Erste", startAt: START });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Erste", startAt: START, simulationTime: START, startCash: 1_000_000, tempo: 1 });
    const id = res.json().id;
    expect((await app.inject({ url: "/api/simulations" })).json()).toHaveLength(1);
    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ url: "/api/simulations" })).json()).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}` })).statusCode).toBe(404);
  });

  it.each([
    [{ startAt: START }],
    [{ name: "", startAt: START }],
    [{ name: "x" }],
    [{ name: "x", startAt: START, startCash: -5 }],
    [{ name: "x", startAt: START, startCash: 1.5 }],
    [{ name: "x", startAt: "gestern" }],
  ])("answers 400 with a message for the body %j", async (body) => {
    const res = await post(make(), "/api/simulations", body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual(expect.any(String));
  });

  it("answers 502 with a readable message and leaves no simulation behind when the source fails", async () => {
    const app = make({ fail: "rate_limited" });
    const res = await post(app, "/api/simulations", { name: "x", startAt: START });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/drosselt/);
    expect((await app.inject({ url: "/api/simulations" })).json()).toEqual([]);
  });

  it("answers 502 with the reason when no instrument has prices for the day", async () => {
    const app = make();
    const res = await post(app, "/api/simulations", { name: "x", startAt: D0 - 30 * 86400 });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/keine Kurse/);
  });

  it("ends a simulation", async () => {
    const app = make();
    const id = await createSim(app);
    const res = await post(app, `/api/simulations/${id}/end`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().endedAt).toEqual(expect.any(Number));
    expect((await post(app, "/api/simulations/9999/end", {})).statusCode).toBe(404);
  });
});

describe("bars", () => {
  it("returns only finished bars, oldest first, at most `limit`", async () => {
    const app = make();
    const id = await createSim(app);
    const res = await app.inject({ url: `/api/simulations/${id}/bars?symbol=SAP.DE&limit=5` });
    expect(res.statusCode).toBe(200);
    const { bars } = res.json();
    expect(bars.map((b: { t: number }) => b.t)).toEqual([5, 6, 7, 8, 9].map((i) => D0 + 7 * H + i * 60));
    for (const b of bars) expect(b.t + 60).toBeLessThanOrEqual(START);
  });

  it("answers 400 for an unknown symbol or a bad limit and 404 for an unknown simulation", async () => {
    const app = make();
    const id = await createSim(app);
    expect((await app.inject({ url: `/api/simulations/${id}/bars?symbol=NOPE` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/simulations/${id}/bars` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/simulations/${id}/bars?symbol=SAP.DE&limit=0` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/simulations/${id}/bars?symbol=SAP.DE&limit=abc` })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/simulations/9999/bars?symbol=SAP.DE" })).statusCode).toBe(404);
  });
});

describe("orders", () => {
  const buy = { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 };

  it("previews the cost the same way a fill would", async () => {
    const app = make();
    const id = await createSim(app);
    const res = await post(app, `/api/simulations/${id}/orders/preview`, buy);
    expect(res.statusCode).toBe(200);
    expect(res.json().cost).toMatchObject({ gross: 10905, commission: 490, total: 11395 });
    expect(res.json().problem).toBeUndefined();
  });

  it("answers 400 when there is no price yet, or the symbol is unknown, or the body is wrong", async () => {
    const app = make();
    const id = await createSim(app);
    expect((await post(app, `/api/simulations/${id}/orders/preview`, { ...buy, symbol: "AAPL" })).statusCode).toBe(400);
    expect((await post(app, `/api/simulations/${id}/orders/preview`, { ...buy, symbol: "NOPE" })).statusCode).toBe(400);
    expect((await post(app, `/api/simulations/${id}/orders/preview`, { ...buy, side: "hold" })).statusCode).toBe(400);
    expect((await post(app, "/api/simulations/9999/orders/preview", buy)).statusCode).toBe(404);
  });

  it("places an order, rejects a bad one with the reason, and cancels", async () => {
    const app = make();
    const id = await createSim(app);
    const ok = await post(app, `/api/simulations/${id}/orders`, { ...buy, kind: "limit", limitPrice: 50 });
    expect(ok.statusCode).toBe(201);
    const orderId = ok.json().orderId;

    const bad = await post(app, `/api/simulations/${id}/orders`, { ...buy, qty: 0 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Menge/);

    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}/orders/${orderId}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}/orders/${orderId}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}/orders/abc` })).statusCode).toBe(400);
  });
});

describe("websocket", () => {
  it("sends a snapshot when a client connects", async () => {
    const app = make();
    const id = await createSim(app);
    const { msgs } = await connect(app, id);
    await until(() => msgs.length >= 1);
    expect(msgs[0]).toMatchObject({
      type: "snapshot", running: false, simulation: { id, simulationTime: START }, depot: { cash: 1_000_000 },
    });
  });

  it("tells a client that asks for an unknown simulation, and closes", async () => {
    const app = make();
    const { msgs, ws } = await connect(app, 9999);
    await until(() => msgs.length >= 1);
    expect(msgs[0].type).toBe("error");
    await until(() => ws.readyState === ws.CLOSED);
  });

  it("ticks while running, moves the time on, and stops on pause", async () => {
    const app = make();
    const id = await createSim(app);
    const { msgs, send } = await connect(app, id);
    send({ type: "tempo", tempo: 60 });
    send({ type: "run" });
    const ticks = () => msgs.filter((m) => m.type === "tick");
    await until(() => ticks().length >= 5);
    expect(ticks()[ticks().length - 1].simulationTime).toBeGreaterThan(ticks()[0].simulationTime);
    expect(ticks()[0]).toMatchObject({ running: true, depot: { cash: 1_000_000 } });
    expect(app.session.snapshot(id).simulation.tempo).toBe(60);

    send({ type: "pause" });
    await until(() => !app.session.isRunning(id));
    await new Promise((r) => setTimeout(r, 60));
    const settled = ticks().length;
    await new Promise((r) => setTimeout(r, 100));
    expect(ticks().length).toBe(settled);
  });

  // A real socket, not injectWS: injected sockets do not pass a graceful close on to the server,
  // so the very thing under test would never happen there.
  it("pauses when the last client leaves, and keeps the time it had reached", async () => {
    const app = make();
    const id = await createSim(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const ticks: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/simulations/${id}`);
    ws.on("message", (d) => {
      if (JSON.parse(String(d)).type === "tick") ticks.push(1);
    });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "tempo", tempo: 60 }));
    ws.send(JSON.stringify({ type: "run" }));
    await until(() => ticks.length >= 3);
    ws.close();
    await until(() => !app.session.isRunning(id));
    const reached = app.session.snapshot(id).simulation.simulationTime;
    expect(reached).toBeGreaterThan(START);
    await new Promise((r) => setTimeout(r, 80));
    expect(app.session.snapshot(id).simulation.simulationTime).toBe(reached);
  });

  it("answers a message it does not understand with an error and carries on", async () => {
    const app = make();
    const id = await createSim(app);
    const { msgs, ws, send } = await connect(app, id);
    await until(() => msgs.length >= 1);
    ws.send("not json");
    send({ type: "tempo", tempo: 7 });
    await until(() => msgs.filter((m) => m.type === "error").length >= 2);
    send({ type: "pause" });
    expect(ws.readyState).toBe(ws.OPEN);
  });

  it("pushes a fresh snapshot to connected clients when an order is placed over HTTP", async () => {
    const app = make();
    const id = await createSim(app);
    const { msgs } = await connect(app, id);
    await until(() => msgs.length >= 1);
    await post(app, `/api/simulations/${id}/orders`, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    await until(() => msgs.some((m) => m.type === "snapshot" && m.depot.orders.length === 1));
    expect(msgs.at(-1).depot.positions[0]).toMatchObject({ symbol: "SAP.DE", qty: 1 });
  });

  it("looks for more data at the end of the data, then pauses with a notice when there is none", async () => {
    const app = make();
    const id = await createSim(app, D1 + 9 * H);
    const { msgs, send } = await connect(app, id);
    send({ type: "run" });
    await until(() => msgs.some((m) => m.type === "notice"));
    expect(msgs.find((m) => m.type === "notice").text).toMatch(/Ende der Daten/);
    expect(app.session.isRunning(id)).toBe(false);
  });

  it("carries on across the night once the next day has been loaded", async () => {
    const app = make();
    const id = await createSim(app, D0 + 15 * H);
    const { msgs, send } = await connect(app, id);
    send({ type: "tempo", tempo: 60 });
    send({ type: "run" });
    await until(() => msgs.some((m) => m.type === "tick" && m.simulationTime >= D1 + 7 * H));
    expect(msgs.some((m) => m.type === "notice")).toBe(false);
  });

  it("shows a source failure as a notice and pauses", async () => {
    const { source } = makeSource();
    let fail = false;
    const app = buildApp({
      dbPath: ":memory:", instruments: [SAP, AAPL], now: () => NOW, minGapMs: 0, tickMs: 20,
      marketData: { bars: (...a) => (fail ? Promise.reject(new MarketDataError("network", "down")) : source.bars(...a)) },
    });
    open.push(app);
    const id = await createSim(app, D1 + 9 * H);
    fail = true;
    const { msgs, send } = await connect(app, id);
    send({ type: "run" });
    await until(() => msgs.some((m) => m.type === "notice"));
    expect(msgs.find((m) => m.type === "notice").text).toMatch(/nicht erreichbar/);
    expect(app.session.isRunning(id)).toBe(false);
  });
});

describe("live simulations over the API", () => {
  const FRIDAY_NOON = D1 + 12 * H; // the live limit is 11:45, SAP's bars on D1 end at 07:10

  it("starts from now when no start is given: at the newest bar, with the live flag", async () => {
    const app = make({ now: FRIDAY_NOON });
    const res = await post(app, "/api/simulations", { name: "Live", live: true });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ live: true, startAt: D1 + 7 * H + 600, simulationTime: D1 + 7 * H + 600 });
  });

  it("takes an earlier start when one is given", async () => {
    const app = make({ now: FRIDAY_NOON });
    const res = await post(app, "/api/simulations", { name: "Live", live: true, startAt: D1 + 7 * H + 120 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ live: true, startAt: D1 + 7 * H + 120 });
  });

  it("a replay is not live", async () => {
    const res = await post(make(), "/api/simulations", { name: "Replay", startAt: START });
    expect(res.json().live).toBe(false);
  });

  it.each([[true], [false]])("refuses a start after the live limit (live: %s) with a message", async (live) => {
    const app = make({ now: FRIDAY_NOON });
    const res = await post(app, "/api/simulations", { name: "x", live, startAt: FRIDAY_NOON - 600 }); // L is 11:45
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Live-Grenze/);
    expect((await app.inject({ url: "/api/simulations" })).json()).toEqual([]);
  });

  it("wants a start unless the simulation is live", async () => {
    const app = make({ now: FRIDAY_NOON });
    expect((await post(app, "/api/simulations", { name: "x" })).statusCode).toBe(400);
    expect((await post(app, "/api/simulations", { name: "x", live: false })).statusCode).toBe(400);
  });

  it("answers 502 and leaves nothing behind when the prices cannot be had", async () => {
    const app = make({ now: FRIDAY_NOON, fail: "rate_limited" });
    const res = await post(app, "/api/simulations", { name: "x", live: true });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/drosselt/);
    expect((await app.inject({ url: "/api/simulations" })).json()).toEqual([]);
  });
});

describe("the clock of a live simulation (websocket)", () => {
  const T0700 = D0 + 7 * H;
  const at = (minute: number) => T0700 + minute * 60;

  /** SAP only. `sapUntil` cuts its bars off, `all` lets a test bring them back, `clock` is the present. */
  function makeLive(opts: { now: number; sapUntil?: number; catchUpTempo?: number; liveRefreshS?: number }) {
    const inner = makeSource();
    const whole = inner.all["SAP.DE"].slice();
    if (opts.sapUntil !== undefined) inner.all["SAP.DE"] = whole.filter((b) => b.t < opts.sapUntil!);
    const clock = { now: opts.now };
    const log: { symbol: string; at: number }[] = [];
    const source: MarketData = {
      bars: async (symbol, from, to) => {
        log.push({ symbol, at: performance.now() });
        return inner.source.bars(symbol, from, to);
      },
    };
    const app = buildApp({
      dbPath: ":memory:", marketData: source, instruments: [SAP], now: () => clock.now, minGapMs: 0, tickMs: 20,
      catchUpTempo: opts.catchUpTempo ?? 6000, liveRefreshS: opts.liveRefreshS ?? 0.1,
    });
    open.push(app);
    return { app, all: inner.all, whole, clock, log };
  }

  async function sim(app: FastifyInstance, body: Record<string, unknown>) {
    const res = await post(app, "/api/simulations", { name: "L", ...body });
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  }

  it("catches up to the live limit and then stays on it, without a word about the end of the data", async () => {
    const t = makeLive({ now: at(45) + 900 }); // the live limit is 07:45, the bars run to 08:00
    const id = await sim(t.app, { live: true, startAt: T0700 });
    const { msgs, send } = await connect(t.app, id);
    await until(() => msgs.length >= 1);
    expect(msgs[0]).toMatchObject({ type: "snapshot", phase: "catchup", simulation: { live: true } });
    send({ type: "run" });
    // Within 120 s of the limit it counts as live, and the next tick snaps onto the limit itself.
    await until(() => msgs.some((m) => m.type === "tick" && m.simulationTime === at(45)));
    const ticks = msgs.filter((m) => m.type === "tick");
    for (const m of ticks) expect(m.simulationTime).toBeLessThanOrEqual(m.liveLimit);
    expect(ticks.some((m) => m.phase === "catchup")).toBe(true);
    expect(ticks[ticks.length - 1]).toMatchObject({ simulationTime: at(45), phase: "live" });
    await new Promise((r) => setTimeout(r, 120));
    expect(msgs.some((m) => m.type === "notice")).toBe(false);
    expect(t.app.session.isRunning(id)).toBe(true);
    expect(t.app.session.snapshot(id).simulation.simulationTime).toBe(at(45));
  });

  it("waits at the edge of the present with one notice, asks the source no oftener than the refresh time, and goes on when bars arrive", async () => {
    const t = makeLive({ now: at(40) + 900, sapUntil: at(30) }); // the last bar ends at 07:30, the limit is 07:40
    const id = await sim(t.app, { live: true, startAt: at(20) });
    const created = t.log.length;
    const { msgs, send } = await connect(t.app, id);
    send({ type: "run" });
    await until(() => msgs.some((m) => m.type === "notice" && /Warte auf neue Kurse/.test(m.text)));
    await new Promise((r) => setTimeout(r, 450)); // several refresh times, with no data yet
    expect(t.app.session.isRunning(id)).toBe(true);

    const sapCalls = t.log.slice(created).filter((c) => c.symbol === "SAP.DE");
    expect(sapCalls.length).toBeGreaterThanOrEqual(2); // it does look again
    for (let i = 1; i < sapCalls.length; i++) expect(sapCalls[i].at - sapCalls[i - 1].at).toBeGreaterThanOrEqual(90); // never oftener than 100 ms

    t.all["SAP.DE"] = t.whole.filter((b) => b.t < at(40)); // the bars up to 07:40 arrive
    await until(() => msgs.some((m) => m.type === "tick" && m.simulationTime >= at(35)));
    expect(msgs.filter((m) => m.type === "notice" && /Warte/.test(m.text))).toHaveLength(1);
    expect(t.app.session.isRunning(id)).toBe(true);
  });

  it("keeps its refresh time across a pause and a new start: a press on Start does not ask the source again", async () => {
    const t = makeLive({ now: D0 + 5 * 86400, liveRefreshS: 5 });
    const id = await sim(t.app, { startAt: D1 + 9 * H }); // a replay at the end of its data, far from the present
    const { msgs, send } = await connect(t.app, id);
    send({ type: "run" });
    await until(() => msgs.filter((m) => m.type === "notice" && /Ende der Daten/.test(m.text)).length >= 1);
    const asked = t.log.length;
    expect(t.app.session.isRunning(id)).toBe(false);

    send({ type: "run" });
    await until(() => msgs.filter((m) => m.type === "notice" && /Ende der Daten/.test(m.text)).length >= 2);
    expect(t.log.length).toBe(asked);
    expect(t.app.session.isRunning(id)).toBe(false);
  });

  it("does not let the tempo be changed for a live simulation, and says why", async () => {
    const t = makeLive({ now: at(45) + 900 });
    const id = await sim(t.app, { live: true, startAt: T0700 });
    const { msgs, send } = await connect(t.app, id);
    await until(() => msgs.length >= 1);
    send({ type: "tempo", tempo: 60 });
    await until(() => msgs.some((m) => m.type === "notice" && /Livebetrieb/.test(m.text)));
    expect(t.app.session.snapshot(id).simulation.tempo).toBe(1);
  });

  it("still lets the tempo of a replay be changed", async () => {
    const t = makeLive({ now: D0 + 5 * 86400 });
    const id = await sim(t.app, { startAt: T0700 });
    const { msgs, send } = await connect(t.app, id);
    await until(() => msgs.length >= 1);
    send({ type: "tempo", tempo: 30 });
    await until(() => t.app.session.snapshot(id).simulation.tempo === 30);
  });
});

describe("search and the watchlist", () => {
  const NEW_DE: SearchHit = { symbol: "NEW.DE", name: "Neu AG", currency: "EUR", venue: "XETRA", kind: "EQUITY" };
  const AAPL_HIT: SearchHit = { ...AAPL, kind: "EQUITY" };

  function withSearch(hits: SearchHit[] | MarketDataErrorKind = [NEW_DE, AAPL_HIT]) {
    const queries: string[] = [];
    const search: InstrumentSearch = {
      async search(q) {
        queries.push(q);
        if (typeof hits === "string") throw new MarketDataError(hits, "fake");
        return hits.filter((h) => h.symbol.toLowerCase().includes(q.toLowerCase()) || h.name.toLowerCase().includes(q.toLowerCase()));
      },
    };
    const { source } = makeSource();
    const app = buildApp({
      dbPath: ":memory:", marketData: source, instruments: [SAP], search, now: () => NOW, minGapMs: 0, tickMs: 20,
    });
    open.push(app);
    return { app, queries };
  }
  const del = (app: FastifyInstance, url: string) => app.inject({ method: "DELETE", url });
  const symbols = async (app: FastifyInstance) => (await app.inject({ url: "/api/watchlist" })).json().map((i: any) => i.symbol);

  it("rejects a query that is too short or too long", async () => {
    const { app, queries } = withSearch();
    expect((await app.inject({ url: "/api/search?q=a" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/search?q=" })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/search?q=${"x".repeat(41)}` })).statusCode).toBe(400);
    expect(queries).toEqual([]);
  });

  it("returns hits and marks the ones already in the list as known", async () => {
    const { app } = withSearch([{ ...AAPL, kind: "EQUITY", symbol: "SAP.DE", name: "SAP" }, NEW_DE]);
    const res = await app.inject({ url: "/api/search?q=%20de%20" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ symbol: "SAP.DE", known: true }),
      expect.objectContaining({ symbol: "NEW.DE", known: false, name: "Neu AG" }),
    ]);
  });

  it("answers a rate limit of the search with 429 and other failures with 502", async () => {
    expect((await withSearch("rate_limited").app.inject({ url: "/api/search?q=abc" })).statusCode).toBe(429);
    expect((await withSearch("network").app.inject({ url: "/api/search?q=abc" })).statusCode).toBe(502);
  });

  it("refuses symbols that are not plain, and the exchange rate, and leaves the list alone", async () => {
    const { app, queries } = withSearch();
    for (const symbol of ["../x", "a b", "", "EURUSD=X", "x".repeat(16), "^GSPC;"]) {
      const res = await post(app, "/api/watchlist", { symbol });
      expect(res.statusCode, symbol).toBe(400);
    }
    expect((await post(app, "/api/watchlist", {})).statusCode).toBe(400);
    expect(queries).toEqual([]);
    expect(await symbols(app)).toEqual(["SAP.DE"]);
  });

  it("answers 404 for a symbol that the search does not return as an exact hit", async () => {
    const { app } = withSearch();
    expect((await post(app, "/api/watchlist", { symbol: "NE" })).statusCode).toBe(404); // a part of NEW.DE
    expect((await post(app, "/api/watchlist", { symbol: "ZZZ" })).statusCode).toBe(404);
    expect(await symbols(app)).toEqual(["SAP.DE"]);
  });

  it("adds a found instrument with name, currency and venue from the search, and a second add changes nothing", async () => {
    const { app } = withSearch();
    const first = await post(app, "/api/watchlist", { symbol: "new.de" });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ symbol: "NEW.DE", name: "Neu AG", currency: "EUR", venue: "XETRA", added: true });
    const again = await post(app, "/api/watchlist", { symbol: "NEW.DE" });
    expect(again.statusCode).toBe(200);
    expect(await symbols(app)).toEqual(["SAP.DE", "NEW.DE"]);
    const list = (await app.inject({ url: "/api/watchlist" })).json();
    expect(list.map((i: any) => i.added)).toEqual([false, true]);
  });

  it("refuses the 13th added instrument with 409 and a clear message", async () => {
    const hits = Array.from({ length: 13 }, (_, n): SearchHit => ({ ...NEW_DE, symbol: `N${n}.DE`, name: `N${n}` }));
    const { app } = withSearch(hits);
    for (let n = 0; n < 12; n++) expect((await post(app, "/api/watchlist", { symbol: `N${n}.DE` })).statusCode).toBe(201);
    const res = await post(app, "/api/watchlist", { symbol: "N12.DE" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/höchstens 12/);
    expect(await symbols(app)).toHaveLength(13);
  });

  it("does not add the instrument when the price source is rate limited, and says 502 or 429", async () => {
    const { source } = makeSource();
    let fail = false;
    const app = buildApp({
      dbPath: ":memory:", instruments: [SAP], now: () => NOW, minGapMs: 0, tickMs: 20,
      search: { search: async () => [AAPL_HIT] },
      marketData: { bars: (...a) => (fail ? Promise.reject(new MarketDataError("rate_limited", "x")) : source.bars(...a)) },
    });
    open.push(app);
    await createSim(app);
    fail = true;
    const res = await post(app, "/api/watchlist", { symbol: "AAPL" });
    expect(res.statusCode).toBe(429);
    expect(await symbols(app)).toEqual(["SAP.DE"]);
  });

  it("removes an added instrument that nobody holds, and refuses the starting list and unknown symbols", async () => {
    const { app } = withSearch();
    await post(app, "/api/watchlist", { symbol: "NEW.DE" });
    expect((await del(app, "/api/watchlist/NEW.DE")).statusCode).toBe(204);
    expect(await symbols(app)).toEqual(["SAP.DE"]);
    expect((await del(app, "/api/watchlist/SAP.DE")).statusCode).toBe(409);
    expect((await del(app, "/api/watchlist/NOPE")).statusCode).toBe(404);
    expect(await symbols(app)).toEqual(["SAP.DE"]);
  });

  it("refuses to remove an instrument that a simulation holds, or has an open order in", async () => {
    const { app } = withSearch();
    await post(app, "/api/watchlist", { symbol: "AAPL" });
    const id = await createSim(app, D0 + 13 * H + 1800 + 600); // AAPL is trading
    const buy = await post(app, `/api/simulations/${id}/orders`, { symbol: "AAPL", side: "buy", kind: "market", qty: 1 });
    expect(buy.statusCode).toBe(201);
    const held = await del(app, "/api/watchlist/AAPL");
    expect(held.statusCode).toBe(409);
    expect(held.json().error).toMatch(/gehalten/);
    expect(await symbols(app)).toEqual(["SAP.DE", "AAPL"]);

    await post(app, `/api/simulations/${id}/orders`, { symbol: "AAPL", side: "sell", kind: "market", qty: 1 });
    await post(app, `/api/simulations/${id}/orders`, { symbol: "AAPL", side: "buy", kind: "limit", qty: 1, limitPrice: 1 });
    expect((await del(app, "/api/watchlist/AAPL")).statusCode).toBe(409); // the limit order is still open
  });
});
