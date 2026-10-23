import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { MarketDataError, type MarketDataErrorKind } from "../src/data/marketdata.js";
import { AAPL, D0, D1, H, SAP, makeSource } from "./fakes.js";

const NOW = D0 + 5 * 86400;
const START = D0 + 7 * H + 600; // 07:10 UTC on D0, SAP is trading

const open: FastifyInstance[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function make(opts: { fail?: MarketDataErrorKind } = {}) {
  const { source } = makeSource(opts);
  const app = buildApp({
    dbPath: ":memory:", marketData: source, instruments: [SAP, AAPL], now: () => NOW, minGapMs: 0, tickMs: 20,
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
  it("lists the watchlist", async () => {
    const res = await make().inject({ url: "/api/watchlist" });
    expect(res.json()).toEqual([
      { symbol: "SAP.DE", name: "SAP", currency: "EUR", venue: "XETRA" },
      { symbol: "AAPL", name: "Apple", currency: "USD", venue: "US" },
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
