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
    const res = await post(app, "/api/simulations", { name: "x", startAt: D0 - 3 * 86400 });
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
      type: "snapshot", running: false, simulation: { id, simulationTime: START }, depots: [{ cash: 1_000_000 }],
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
    expect(ticks()[0]).toMatchObject({ running: true, depots: [{ cash: 1_000_000 }] });
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

  it("deleting a simulation with a connected client stops the clock, closes the client and forgets the leftovers of the tick", async () => {
    const app = make();
    const id = await createSim(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/simulations/${id}`);
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    let ticks = 0;
    ws.on("message", (d) => { if (JSON.parse(String(d)).type === "tick") ticks++; });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "tempo", tempo: 60 }));
    ws.send(JSON.stringify({ type: "run" }));
    await until(() => ticks >= 2);
    expect(app.session.isRunning(id)).toBe(true);
    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}` })).statusCode).toBe(204);
    expect(await closed).toBe(1000);
    expect(app.session.isRunning(id)).toBe(false);
    expect((app.session as unknown as { carry: Map<number, number> }).carry.has(id)).toBe(false);
    expect((await app.inject({ url: "/api/simulations" })).json()).toEqual([]);
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
    await until(() => msgs.some((m) => m.type === "snapshot" && m.depots[0].orders.length === 1));
    expect(msgs.at(-1).depots[0].positions[0]).toMatchObject({ symbol: "SAP.DE", qty: 1 });
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

    // one notice for the whole wait; after the bars arrive the clock may meet the new edge and say it again, which is a new wait
    expect(msgs.filter((m) => m.type === "notice" && /Warte/.test(m.text))).toHaveLength(1);
    t.all["SAP.DE"] = t.whole.filter((b) => b.t < at(40)); // the bars up to 07:40 arrive
    await until(() => msgs.some((m) => m.type === "tick" && m.simulationTime >= at(35)));
    expect(t.app.session.isRunning(id)).toBe(true);
  });

  it("tells a client that joins during the wait why the clock stands", async () => {
    const t = makeLive({ now: at(40) + 900, sapUntil: at(30) });
    const id = await sim(t.app, { live: true, startAt: at(20) });
    const first = await connect(t.app, id);
    first.send({ type: "run" });
    await until(() => first.msgs.some((m) => m.type === "notice" && /Warte auf neue Kurse/.test(m.text)));
    const late = await connect(t.app, id);
    await until(() => late.msgs.some((m) => m.type === "notice" && /Warte auf neue Kurse/.test(m.text)));
  });

  it("says the market is shut on a holiday, not 'waiting' and not 'end of data'", async () => {
    const XMAS = Date.parse("2026-12-25T12:00:00Z") / 1000; // 1. Weihnachtstag, a Friday: Xetra is shut
    const t = makeLive({ now: XMAS });
    const id = await sim(t.app, { live: true, startAt: T0700 });
    const { msgs, send } = await connect(t.app, id);
    send({ type: "run" });
    await until(() => msgs.some((m) => m.type === "notice"));
    const notices = msgs.filter((m) => m.type === "notice").map((m) => m.text);
    expect(notices).toEqual(["Markt geschlossen (Feiertag: 1. Weihnachtstag)."]);
    expect(t.app.session.isRunning(id)).toBe(false);
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

  it("sends a fresh snapshot to a connected client after an add and after a remove, even while the clock stands", async () => {
    const { app } = withSearch();
    const id = await createSim(app, D0 + 13 * H + 1800 + 600); // AAPL is trading
    const { msgs } = await connect(app, id);
    await until(() => msgs.some((m) => m.type === "snapshot"));
    expect(msgs.at(-1).prices.AAPL).toBeUndefined();

    await post(app, "/api/watchlist", { symbol: "AAPL" });
    await until(() => msgs.at(-1).prices?.AAPL !== undefined);
    expect(msgs.at(-1).type).toBe("snapshot");

    await del(app, "/api/watchlist/AAPL");
    await until(() => msgs.at(-1).prices?.AAPL === undefined);
    expect(msgs.at(-1).type).toBe("snapshot");
  });

  it("removes by symbol whatever its case, like the add matches whatever its case", async () => {
    const { app } = withSearch();
    await post(app, "/api/watchlist", { symbol: "NEW.DE" });
    expect((await del(app, "/api/watchlist/new.de")).statusCode).toBe(204);
    expect(await symbols(app)).toEqual(["SAP.DE"]);
    expect((await del(app, "/api/watchlist/sap.de")).statusCode).toBe(409); // still the starting list
  });

  it("keeps one entry when the same new symbol is added twice at the same moment", async () => {
    const { app } = withSearch();
    const [a, b] = await Promise.all([
      post(app, "/api/watchlist", { symbol: "NEW.DE" }),
      post(app, "/api/watchlist", { symbol: "NEW.DE" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(await symbols(app)).toEqual(["SAP.DE", "NEW.DE"]);
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

describe("depots", () => {
  const depots = async (app: FastifyInstance, id: number) =>
    (await app.inject({ url: `/api/simulations/${id}/curves` })).json().depots as { id: number; name: string; points: { t: number; value: number }[] }[];

  it("adds, renames and deletes a depot, and refuses to delete the last one", async () => {
    const app = make();
    const id = await createSim(app);
    const added = await post(app, `/api/simulations/${id}/depots`, { name: "Zweit" });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ name: "Zweit", cash: 1_000_000 });
    const second = added.json().id;

    const renamed = await app.inject({ method: "PATCH", url: `/api/simulations/${id}/depots/${second}`, payload: { name: "Wachstum" } });
    expect(renamed.json().name).toBe("Wachstum");

    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}/depots/${second}` })).statusCode).toBe(204);
    const first = (await depots(app, id))[0].id;
    const last = await app.inject({ method: "DELETE", url: `/api/simulations/${id}/depots/${first}` });
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toMatch(/letzte Depot/);
  });

  it("answers 404 for an unknown depot or simulation and 400 for a bad name", async () => {
    const app = make();
    const id = await createSim(app);
    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}/depots/9999` })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/simulations/${id}/depots/9999`, payload: { name: "x" } })).statusCode).toBe(404);
    expect((await post(app, `/api/simulations/9999/depots`, {})).statusCode).toBe(404);
    expect((await post(app, `/api/simulations/${id}/depots`, { name: "" })).statusCode).toBe(400);
  });

  it("answers 409 at the eighth depot and for an ended simulation", async () => {
    const app = make();
    const id = await createSim(app);
    for (let n = 2; n <= 8; n++) expect((await post(app, `/api/simulations/${id}/depots`, {})).statusCode).toBe(201);
    expect((await post(app, `/api/simulations/${id}/depots`, {})).statusCode).toBe(409);
    const other = await createSim(app);
    await post(app, `/api/simulations/${other}/end`, {});
    expect((await post(app, `/api/simulations/${other}/depots`, {})).statusCode).toBe(409);
  });

  it("places an order in the chosen depot only, and refuses a depot of another simulation", async () => {
    const app = make();
    const id = await createSim(app);
    const other = await createSim(app);
    const second = (await post(app, `/api/simulations/${id}/depots`, {})).json().id;
    const order = { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 };
    expect((await post(app, `/api/simulations/${id}/orders`, { ...order, depotId: second })).statusCode).toBe(201);
    await app.ready();
    const snap = await connect(app, id);
    await until(() => snap.msgs.length > 0);
    const [d1, d2] = snap.msgs[0].depots;
    expect(d1.positions).toEqual([]);
    expect(d2.positions).toHaveLength(1);
    const foreign = (await app.inject({ url: `/api/simulations/${other}/curves` })).json().depots[0].id;
    const res = await post(app, `/api/simulations/${id}/orders`, { ...order, depotId: foreign });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unbekanntes Depot/);
  });

  it("previews against the chosen depot", async () => {
    const app = make();
    const id = await createSim(app);
    const second = (await post(app, `/api/simulations/${id}/depots`, {})).json().id;
    const res = await post(app, `/api/simulations/${id}/orders/preview`, {
      symbol: "SAP.DE", side: "sell", kind: "market", qty: 1, depotId: second,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().problem).toEqual(expect.any(String)); // nothing to sell in that depot
  });

  it("plans and then places an allocation", async () => {
    const app = make();
    const id = await createSim(app);
    const depotId = (await depots(app, id))[0].id;
    const url = `/api/simulations/${id}/depots/${depotId}/allocate`;
    const dry = await post(app, url, { weights: [{ symbol: "SAP.DE", percent: 50 }], dryRun: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().lines[0]).toMatchObject({ symbol: "SAP.DE", percent: 50 });
    expect(dry.json().lines[0].qty).toBeGreaterThan(0);
    const real = await post(app, url, { weights: [{ symbol: "SAP.DE", percent: 50 }] });
    expect(real.statusCode).toBe(200);
    const snap = await connect(app, id);
    await until(() => snap.msgs.length > 0);
    expect(snap.msgs[0].depots[0].positions[0]).toMatchObject({ symbol: "SAP.DE", qty: real.json().lines[0].qty });
  });

  it("answers 400 for weights above 100 percent or a bad body, and 404 for a unknown depot", async () => {
    const app = make();
    const id = await createSim(app);
    const depotId = (await depots(app, id))[0].id;
    const url = `/api/simulations/${id}/depots/${depotId}/allocate`;
    expect((await post(app, url, { weights: [{ symbol: "SAP.DE", percent: 120 }] })).statusCode).toBe(400);
    expect((await post(app, url, { weights: [{ symbol: "SAP.DE", percent: 0 }] })).statusCode).toBe(400);
    expect((await post(app, url, { weights: [] })).statusCode).toBe(400);
    expect((await post(app, url, { nope: 1 })).statusCode).toBe(400);
    expect((await post(app, `/api/simulations/${id}/depots/9999/allocate`, { weights: [{ symbol: "SAP.DE", percent: 10 }] })).statusCode).toBe(404);
  });

  it("serves the curves of every depot with their start point", async () => {
    const app = make();
    const id = await createSim(app);
    await post(app, `/api/simulations/${id}/depots`, { name: "Zweit" });
    const list = await depots(app, id);
    expect(list.map((d) => d.name)).toEqual(["Depot 1", "Zweit"]);
    expect(list[0].points).toEqual([{ t: START, value: 1_000_000 }]);
    expect((await app.inject({ url: `/api/simulations/9999/curves` })).statusCode).toBe(404);
  });
});

describe("benchmark and evaluation", () => {
  it("sets, shows and clears the benchmark", async () => {
    const app = make();
    const id = await createSim(app);
    const set = await app.inject({ method: "PATCH", url: `/api/simulations/${id}`, payload: { benchmark: "SAP.DE" } });
    expect(set.statusCode).toBe(200);
    expect(set.json().benchmark).toBe("SAP.DE");
    const curves = (await app.inject({ url: `/api/simulations/${id}/curves` })).json();
    expect(curves.benchmark).toMatchObject({ symbol: "SAP.DE", currency: "EUR" });
    const cleared = await app.inject({ method: "PATCH", url: `/api/simulations/${id}`, payload: { benchmark: null } });
    expect(cleared.json().benchmark).toBeNull();
    expect((await app.inject({ url: `/api/simulations/${id}/curves` })).json().benchmark).toBeNull();
  });

  it("tells connected clients when the benchmark changes", async () => {
    const app = make();
    const id = await createSim(app);
    const client = await connect(app, id);
    await until(() => client.msgs.length > 0);
    await app.inject({ method: "PATCH", url: `/api/simulations/${id}`, payload: { benchmark: "SAP.DE" } });
    await until(() => client.msgs.some((m) => m.type === "snapshot" && m.simulation.benchmark === "SAP.DE"));
  });

  it("answers 400 for a symbol that is not in the list, 400 for a bad body and 404 for an unknown simulation", async () => {
    const app = make();
    const id = await createSim(app);
    const patch = (url: string, payload: unknown) => app.inject({ method: "PATCH", url, payload: payload as object });
    expect((await patch(`/api/simulations/${id}`, { benchmark: "NOPE" })).statusCode).toBe(400);
    expect((await patch(`/api/simulations/${id}`, { benchmark: 5 })).statusCode).toBe(400);
    expect((await patch(`/api/simulations/${id}`, {})).statusCode).toBe(400);
    expect((await patch(`/api/simulations/9999`, { benchmark: null })).statusCode).toBe(404);
  });

  it("keeps an added title in the list while it is the benchmark of a simulation", async () => {
    const hit: SearchHit = { symbol: "BMW.DE", name: "BMW", currency: "EUR", venue: "XETRA", kind: "EQUITY" };
    const { source } = makeSource();
    const app = buildApp({
      dbPath: ":memory:", marketData: source, instruments: [SAP, AAPL], now: () => NOW, minGapMs: 0, tickMs: 20,
      search: { search: async () => [hit] },
    });
    open.push(app);
    const id = await createSim(app);
    await post(app, "/api/watchlist", { symbol: "BMW.DE" });
    await app.inject({ method: "PATCH", url: `/api/simulations/${id}`, payload: { benchmark: "BMW.DE" } });
    const refused = await app.inject({ method: "DELETE", url: "/api/watchlist/BMW.DE" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/Maßstab/);
    await app.inject({ method: "PATCH", url: `/api/simulations/${id}`, payload: { benchmark: null } });
    expect((await app.inject({ method: "DELETE", url: "/api/watchlist/BMW.DE" })).statusCode).toBe(204);
  });

  it("serves the evaluation, without NaN, and 404 for an unknown simulation", async () => {
    const app = make();
    const id = await createSim(app);
    await post(app, `/api/simulations/${id}/depots`, {});
    const res = await app.inject({ url: `/api/simulations/${id}/evaluation` });
    expect(res.statusCode).toBe(200);
    const ev = res.json();
    expect(ev.depots).toHaveLength(2);
    expect(ev.depots[0]).toMatchObject({ name: "Depot 1", startedAt: START });
    expect(ev.depots[0].metrics.unavailable).toMatch(/zu wenige/);
    expect(ev.correlation.matrix).toEqual([[1, null], [null, 1]]);
    expect(ev.benchmark).toBeNull();
    expect(typeof ev.note).toBe("string");
    expect((await app.inject({ url: `/api/simulations/9999/evaluation` })).statusCode).toBe(404);
  });
});

describe("ghost depots over HTTP", () => {
  it("creates a ghost from a depot with a position, shows its kind, and refuses trading on it", async () => {
    const app = make();
    const id = await createSim(app);
    const source = (await app.inject({ url: `/api/simulations/${id}/curves` })).json().depots[0].id;
    const none = await post(app, `/api/simulations/${id}/depots/${source}/ghost`, {});
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toMatch(/Position/);

    await post(app, `/api/simulations/${id}/orders`, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 2 });
    const made = await post(app, `/api/simulations/${id}/depots/${source}/ghost`, {});
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ name: "Geist von Depot 1", kind: "ghost", simulationId: id });
    const ghost = made.json().id;

    const order = { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1, depotId: ghost };
    const placed = await post(app, `/api/simulations/${id}/orders`, order);
    expect(placed.statusCode).toBe(400);
    expect(placed.json().error).toMatch(/Geisterdepot/);
    expect((await post(app, `/api/simulations/${id}/orders/preview`, order)).statusCode).toBe(400);
    expect((await post(app, `/api/simulations/${id}/depots/${ghost}/allocate`, { weights: [{ symbol: "SAP.DE", percent: 10 }] })).statusCode).toBe(400);
    expect((await post(app, `/api/simulations/${id}/depots/${ghost}/ghost`, {})).statusCode).toBe(409);

    const curves = (await app.inject({ url: `/api/simulations/${id}/curves` })).json();
    expect(curves.depots.map((d: any) => d.kind)).toEqual(["normal", "ghost"]);
    const renamed = await app.inject({ method: "PATCH", url: `/api/simulations/${id}/depots/${ghost}`, payload: { name: "Kopie" } });
    expect(renamed.json()).toMatchObject({ name: "Kopie", kind: "ghost" });
    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}/depots/${ghost}` })).statusCode).toBe(204);
    expect((await post(app, `/api/simulations/${id}/depots/9999/ghost`, {})).statusCode).toBe(404);
    expect((await post(app, `/api/simulations/9999/depots/1/ghost`, {})).statusCode).toBe(404);
  });
});

describe("tax over HTTP", () => {
  it("is off at first, takes settings, and then reports taxes, the net curve and the friction", async () => {
    const app = make();
    const id = await createSim(app);
    const off = await app.inject({ url: `/api/simulations/${id}/tax` });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, report: null, settings: { enabled: false, church: 0, allowance: null } });
    expect(off.json().vorabpauschale.computed).toBe(false);

    const bad = await app.inject({ method: "PUT", url: `/api/simulations/${id}/tax`, payload: { church: 0.5 } as object });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({ method: "PUT", url: `/api/simulations/${id}/tax`, payload: { nope: 1 } as object });
    expect(unknown.statusCode).toBe(400);

    const put = await app.inject({ method: "PUT", url: `/api/simulations/${id}/tax`, payload: { enabled: true, church: 0.09, allowance: 500 } as object });
    expect(put.json()).toMatchObject({ enabled: true, church: 0.09, allowance: 500 });
    const o = { symbol: "SAP.DE", kind: "market", qty: 2 };
    await post(app, `/api/simulations/${id}/orders`, { ...o, side: "buy" });
    await post(app, `/api/simulations/${id}/orders`, { ...o, side: "sell" });

    const on = (await app.inject({ url: `/api/simulations/${id}/tax` })).json();
    expect(on.enabled).toBe(true);
    expect(on.rules).toMatchObject({ allowance: 500, allowanceIsDefault: false });
    expect(on.rules.rate).toBeCloseTo(0.27995, 4);
    expect(on.report.total).toBe(0); // the round trip lost money: no tax, the loss is carried
    expect(on.report.years[0].carryOutStock).toBeLessThan(0);
    expect(on.report.curve.length).toBeGreaterThan(0);
    expect(on.report.friction.fees).toBeGreaterThan(0);
    expect(on.report.friction.tax).toBe(0);
    expect(on.report.net.totalReturn).toBe(on.report.gross.totalReturn); // no tax owed: the same curve

    const off2 = await app.inject({ method: "PUT", url: `/api/simulations/${id}/tax`, payload: { enabled: false } as object });
    expect(off2.json()).toMatchObject({ enabled: false, church: 0.09 });
  });

  it("figures from stored prices are dropped when prices are added later, and a trade key is found without reading prices", async () => {
    const app = make();
    const id = await createSim(app);
    const o = { symbol: "SAP.DE", kind: "market", qty: 2 };
    await post(app, `/api/simulations/${id}/orders`, { ...o, side: "buy" });
    await post(app, `/api/simulations/${id}/orders`, { ...o, side: "sell" });
    const j = (await app.inject({ url: `/api/simulations/${id}/journal` })).json();
    const inner = app.session as unknown as { derivedCache: Map<string, unknown>; excursionCache: Map<string, unknown> };
    expect(inner.derivedCache.size).toBe(1);
    expect((await app.inject({ url: `/api/simulations/${id}/journal` })).json().behavior).toEqual(j.behavior); // from the memo
    expect(app.session.hasTrade(id, j.trades[0].key)).toBe(true);
    expect(app.session.hasTrade(id, "9:9")).toBe(false);
    // a deleted simulation takes the figures with it: depot ids come back with the next one
    expect((await app.inject({ method: "DELETE", url: `/api/simulations/${id}` })).statusCode).toBe(204);
    expect(inner.derivedCache.size).toBe(0);
    expect(inner.excursionCache.size).toBe(0);
    const id2 = await createSim(app);
    await post(app, `/api/simulations/${id2}/orders`, { ...o, side: "buy" });
    await post(app, `/api/simulations/${id2}/orders`, { ...o, side: "sell" });
    const j2 = (await app.inject({ url: `/api/simulations/${id2}/journal` })).json();
    expect(Object.keys(j2.excursions.trades)).toEqual([j2.trades[0].key]);
    app.session.dataChanged();
    expect(inner.derivedCache.size).toBe(0);
    expect(inner.excursionCache.size).toBe(0);
  });

  it("answers 404 for an unknown simulation", async () => {
    const app = make();
    expect((await app.inject({ url: "/api/simulations/9999/tax" })).statusCode).toBe(404);
  });
});

describe("journal over HTTP", () => {
  const trade = async (app: FastifyInstance, id: number, depotId?: number) => {
    const o = { symbol: "SAP.DE", kind: "market", qty: 2, ...(depotId ? { depotId } : {}) };
    await post(app, `/api/simulations/${id}/orders`, { ...o, side: "buy" });
    await post(app, `/api/simulations/${id}/orders`, { ...o, side: "sell" });
  };

  it("lists the trades of the first normal depot with the figures and their basis", async () => {
    const app = make();
    const id = await createSim(app);
    await trade(app, id);
    const res = await app.inject({ url: `/api/simulations/${id}/journal` });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({ simulationTime: START, fewData: true, open: [], hitRate: { n: 1, wins: 0, rate: 0 }, holding: { n: 1, medianSeconds: 0, meanSeconds: 0 } });
    expect(j.depotId).toBe((await app.inject({ url: `/api/simulations/${id}/curves` })).json().depots[0].id);
    expect(j.trades).toHaveLength(1);
    expect(j.trades[0]).toMatchObject({ symbol: "SAP.DE", qty: 2, note: null, key: expect.stringMatching(/^\d+:\d+$/) });
    expect(j.trades[0].netPnl).toBeLessThan(0); // spread and fees
    expect(j.tooEarly).toHaveLength(2);
    expect(j.tooEarly[0]).toMatchObject({ days: 1, n: 0, rate: null, avgMovePct: null });
    expect(j.sales[0].horizons.map((h: any) => h.status)).toEqual(["open", "open"]);
    // the behaviour part is additive and, with one trade, gives no figure
    expect(j.excursions).toMatchObject({ benchmark: null, open: [], summary: { n: 0, medianMaePct: null } });
    expect(Object.keys(j.excursions.trades)).toEqual([j.trades[0].key]);
    expect(j.behavior).toMatchObject({ trades: 1, minTrades: 10, disposition: { ok: false, realizedLosses: 1 }, holding: { ok: false }, timeOfDay: { ok: false } });
  });

  it("stores, replaces and deletes a note, and joins it into the journal", async () => {
    const app = make();
    const id = await createSim(app);
    await trade(app, id);
    const key = (await app.inject({ url: `/api/simulations/${id}/journal` })).json().trades[0].key;
    const put = (text: unknown) => app.inject({ method: "PUT", url: `/api/simulations/${id}/journal/${key}`, payload: { text } as object });
    expect((await put("Zu früh raus")).json()).toEqual({ tradeKey: key, text: "Zu früh raus" });
    expect((await app.inject({ url: `/api/simulations/${id}/journal` })).json().trades[0].note).toBe("Zu früh raus");
    await put("Neu");
    expect((await app.inject({ url: `/api/simulations/${id}/journal` })).json().trades[0].note).toBe("Neu");
    expect((await put("")).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/simulations/${id}/journal` })).json().trades[0].note).toBeNull();
    expect((await put("x".repeat(501))).statusCode).toBe(400);
    expect((await put("x".repeat(500))).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/simulations/${id}/journal/99:98`, payload: { text: "a" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/simulations/${id}/journal/abc`, payload: { text: "a" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/simulations/9999/journal/${key}`, payload: { text: "a" } })).statusCode).toBe(404);
  });

  it("serves a chosen depot, refuses a ghost and answers 404 for unknown ones", async () => {
    const app = make();
    const id = await createSim(app);
    const second = (await post(app, `/api/simulations/${id}/depots`, {})).json().id;
    await trade(app, id, second);
    expect((await app.inject({ url: `/api/simulations/${id}/journal?depotId=${second}` })).json().trades).toHaveLength(1);
    expect((await app.inject({ url: `/api/simulations/${id}/journal` })).json().trades).toHaveLength(0);
    await post(app, `/api/simulations/${id}/orders`, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1, depotId: second });
    const ghost = (await post(app, `/api/simulations/${id}/depots/${second}/ghost`, {})).json().id;
    const refused = await app.inject({ url: `/api/simulations/${id}/journal?depotId=${ghost}` });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Geisterdepot/);
    expect((await app.inject({ url: `/api/simulations/${id}/journal?depotId=9999` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/simulations/9999/journal` })).statusCode).toBe(404);
  });
});

describe("simulation comparison", () => {
  const compare = (app: FastifyInstance, ids: string) => app.inject({ url: `/api/simulations/compare?ids=${ids}` });

  it("gives each simulation its normalised curves and figures on its own time axis", async () => {
    const app = make();
    const a = await createSim(app);
    const b = await createSim(app, START + 300);
    await post(app, `/api/simulations/${a}/orders`, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 2 });
    await app.session.tick(a, 120_000);
    const res = await compare(app, `${a},${b}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.simulations.map((s: any) => s.id)).toEqual([a, b]);
    const first = body.simulations[0];
    expect(first).toMatchObject({ name: "T", startAt: START, simulationTime: START + 120 });
    const depot = first.depots[0];
    expect(depot).toMatchObject({ kind: "normal", startedAt: START });
    expect(depot.points[0]).toEqual({ t: START, pct: 0 });
    expect(depot.points.at(-1).t).toBe(START + 120);
    expect(depot.figures).toMatchObject({ trades: 1, fees: 490 });
    expect(depot.figures.returnPct).toBeCloseTo(((depot.points.at(-1).pct) * 1), 10);
    expect(depot.figures.maxDrawdownPct).toBeLessThanOrEqual(0);
    // the second simulation has its own, later clock and no trades
    expect(body.simulations[1].simulationTime).toBe(START + 300);
    expect(body.simulations[1].depots[0].figures).toMatchObject({ trades: 0, fees: 0, returnPct: null });
    expect(body.note).toMatch(/eigenen Simulationszeit/);
  });

  it("marks ghosts, thins long curves to 400 points and dedupes the ids", async () => {
    const app = make();
    const a = await createSim(app);
    const b = await createSim(app);
    await post(app, `/api/simulations/${a}/orders`, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    const depotId = (await app.inject({ url: `/api/simulations/${a}/curves` })).json().depots[0].id;
    await post(app, `/api/simulations/${a}/depots/${depotId}/ghost`, {});
    const long = (app as any).session; // 1000 minutes of curve for the first depot
    for (let i = 0; i < 1000; i++) long.store.recordValue(depotId, START + 60 * (i + 1), 1_000_000 + i);
    const body = (await compare(app, `${a},${b},${a}`)).json();
    expect(body.simulations).toHaveLength(2);
    expect(body.simulations[0].depots.map((d: any) => d.kind)).toEqual(["normal", "ghost"]);
    expect(body.simulations[0].depots[0].points.length).toBeLessThanOrEqual(400);
    expect(body.simulations[0].depots[0].points[0].t).toBe(START);
  });

  it("answers 404 with a message for an unknown simulation and 400 for a bad list", async () => {
    const app = make();
    const a = await createSim(app);
    const b = await createSim(app);
    const missing = await compare(app, `${a},9999`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Unbekannte Simulation 9999.");
    expect((await compare(app, `${a}`)).statusCode).toBe(400);
    expect((await compare(app, `${a},${a}`)).statusCode).toBe(400);
    expect((await compare(app, `${a},x`)).statusCode).toBe(400);
    expect((await compare(app, ``)).statusCode).toBe(400);
    const many = [a, b, ...[1, 2, 3].map(async () => createSim(app))];
    expect((await compare(app, (await Promise.all(many)).join(","))).statusCode).toBe(400);
    // a normal id route still works next to it
    expect((await app.inject({ url: `/api/simulations/${a}/curves` })).statusCode).toBe(200);
  });
});

describe("orderbook over HTTP", () => {
  it("serves a labelled, simulated book while the market is open", async () => {
    const app = make();
    const id = await createSim(app);
    const res = await app.inject({ url: `/api/simulations/${id}/orderbook?symbol=SAP.DE` });
    expect(res.statusCode).toBe(200);
    const book = res.json();
    expect(book).toMatchObject({ available: true, simulated: true, symbol: "SAP.DE", currency: "EUR", label: expect.stringMatching(/^SIMULIERT, keine echten Tiefendaten/) });
    expect(book.asks).toHaveLength(5);
    expect(book.bids).toHaveLength(5);
    expect(book.asks[0].price).toBeGreaterThan(book.mid);
    expect(book.bids[0].price).toBeLessThan(book.mid);
  });

  it("says why there is none when the venue is shut, and rejects an unknown symbol or simulation", async () => {
    const app = make();
    const id = await createSim(app, D0 + 12 * H); // SAP stopped trading at 08:00 UTC
    const shut = await app.inject({ url: `/api/simulations/${id}/orderbook?symbol=SAP.DE` });
    expect(shut.json()).toMatchObject({ available: false, simulated: true, reason: expect.stringMatching(/geschlossen/) });
    expect((await app.inject({ url: `/api/simulations/${id}/orderbook?symbol=NOPE` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/simulations/${id}/orderbook` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/simulations/9999/orderbook?symbol=SAP.DE` })).statusCode).toBe(404);
  });

  it("changes neither the fill price nor the fees of a market order", async () => {
    const fillOf = async (withBook: boolean) => {
      const app = make();
      const id = await createSim(app);
      if (withBook) for (let i = 0; i < 3; i++) await app.inject({ url: `/api/simulations/${id}/orderbook?symbol=SAP.DE` });
      await post(app, `/api/simulations/${id}/orders`, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 3 });
      const snap = await connect(app, id);
      await until(() => snap.msgs.length > 0);
      return snap.msgs[0].depots[0].orders[0];
    };
    const plain = await fillOf(false);
    const looked = await fillOf(true);
    expect(looked.fillPrice).toBe(plain.fillPrice);
    expect(looked).toMatchObject({ gross: plain.gross, commission: plain.commission, foreignFee: plain.foreignFee, status: "filled" });
  });
});

describe("GET /api/fx and the rate fetch in the app", () => {
  const ecbRows = [
    { day: "2026-10-22", rates: { USD: 1.075 } },
    { day: "2026-10-23", rates: { USD: 1.08 } },
  ];
  const failing = { on: false };
  const withFx = (calls: string[]) => {
    const app = buildApp({
      dbPath: ":memory:", marketData: makeSource().source, instruments: [SAP, AAPL], now: () => D0 + 5 * 86400, minGapMs: 0, tickMs: 20,
      fxSource: { fetch: async (range) => { calls.push(range); if (failing.on) throw new MarketDataError("network", "down"); return ecbRows; } },
    });
    open.push(app);
    return app;
  };

  it("404 before any rate was fetched, then the rows with source and last day", async () => {
    const app = withFx([]);
    expect((await app.inject({ url: "/api/fx?ccy=USD" })).statusCode).toBe(404);
    await app.fx.update();
    const body = (await app.inject({ url: "/api/fx?ccy=usd&from=2026-10-22" })).json();
    expect(body).toMatchObject({ ccy: "USD", latestDay: "2026-10-23", latest: { day: "2026-10-23", rate: 1.08 }, fetchError: null });
    expect(body.rows).toEqual([{ day: "2026-10-22", rate: 1.075, filled: false }, { day: "2026-10-23", rate: 1.08, filled: false }]);
    expect(body.source).toContain("Europäische Zentralbank");
  });

  it("refuses a bad currency or day", async () => {
    const app = withFx([]);
    expect((await app.inject({ url: "/api/fx?ccy=DOLLAR" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/fx?ccy=USD&from=gestern" })).statusCode).toBe(400);
  });

  it("does not fetch by itself unless the check is switched on", async () => {
    const calls: string[] = [];
    withFx(calls);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
  });

  it("a failed fetch shows up as fetchError and keeps the old rates", async () => {
    const app = withFx([]);
    await app.fx.update();
    failing.on = true;
    expect((await app.fx.update()).ok).toBe(false);
    failing.on = false;
    const body = (await app.inject({ url: "/api/fx?ccy=USD" })).json();
    expect(body.latest.day).toBe("2026-10-23");
    await app.fx.update();
    failing.on = true;
    await app.fx.update();
    expect((await app.inject({ url: "/api/fx?ccy=USD" })).json().fetchError).toMatch(/nicht erreichbar/);
  });
});
