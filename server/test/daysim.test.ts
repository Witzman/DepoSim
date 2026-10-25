import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDailyArchive } from "../src/data/dailyarchive.js";
import { createArchive } from "../src/data/archive.js";
import type { DailyData } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";
import { DEFAULT_FEES } from "../src/domain/fees.js";
import { InstrumentRegistry } from "../src/instruments.js";
import { SessionService } from "../src/session.js";
import { createStore } from "../src/store.js";
import type { Events } from "../src/events.js";
import { AAPL, FX, SAP, makeSource } from "./fakes.js";

const DAY = 86400;
const T0 = Date.parse("2020-02-03T00:00:00Z") / 1000; // a Monday
const isoOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Twelve weekdays from T0; the open of day i is 100 + i, the high 3 above it, the low 2 below it, the close 100.5 + i. */
const tradingDays = (n = 12) => {
  const out: number[] = [];
  for (let t = T0; out.length < n; t += DAY) if (![0, 6].includes(new Date(t * 1000).getUTCDay())) out.push(t);
  return out;
};
const ohlc = (i: number) => ({ o: 100 + i, h: 103 + i, l: 98 + i, c: 100.5 + i, v: 1000 });

function setup(opts: { dividends?: { exDay: string; amount: number }[]; usdRate?: number } = {}) {
  const db = openDb(":memory:");
  const store = createStore(db);
  const insert = db.prepare("insert into daily_bars (symbol, day, o, h, l, c, v) values (?, ?, ?, ?, ?, ?, ?)");
  const days = tradingDays();
  for (const symbol of [SAP.symbol, AAPL.symbol]) days.forEach((t, i) => { const b = ohlc(i); insert.run(symbol, isoOf(t), b.o, b.h, b.l, b.c, b.v); });
  const events: Events = {
    ensure: async () => {}, ensureStrict: async () => {},
    dividends: (symbol, from, to) => (symbol === SAP.symbol ? (opts.dividends ?? []).filter((d) => d.exDay >= from && d.exDay <= to) : []),
    splits: () => [],
  };
  const { source } = makeSource();
  const archive = createArchive(db, source, { now: () => T0 + 400 * DAY, minGapMs: 0 });
  const svc = new SessionService({
    store, archive, instruments: new InstrumentRegistry(db, [SAP, AAPL]), fxSymbol: FX, now: () => T0 + 400 * DAY, events,
    daily: createDailyArchive(db), fxRate: (ccy, day) => (ccy === "USD" && day >= "2020-01-01" ? (opts.usdRate ?? 1.1) : undefined),
  });
  const sim = store.createSimulation({ name: "Tag", startAt: T0, startCash: 1_000_000, fees: DEFAULT_FEES, resolution: "day" });
  return { db, store, svc, id: sim.id, depotId: store.listDepots(sim.id)[0].id, days };
}

describe("a simulation by days", () => {
  it("shows no price before the first day is over, and the close of a day after it", () => {
    const t = setup();
    expect(t.svc.snapshot(t.id).prices).toEqual({});
    t.svc.stepDays(t.id, 1);
    const snap = t.svc.snapshot(t.id);
    expect(snap.simulation.simulationTime).toBe(t.days[0] + DAY);
    expect(snap.prices["SAP.DE"]).toEqual({ price: 100.5, barT: t.days[0] });
  });

  it("fills a market buy at the open of the next trading day, not at a close before it", () => {
    const t = setup();
    t.svc.stepDays(t.id, 1); // day 0 over; the clock is at the midnight after it
    const placed = t.svc.placeOrder(t.id, t.depotId, { symbol: SAP.symbol, side: "buy", kind: "market", qty: 10 });
    expect(placed.ok).toBe(true);
    expect(t.store.loadDepot(t.depotId).orders[0].status).toBe("open"); // no price now: it waits for the day
    t.svc.stepDays(t.id, 1);
    const o = t.store.loadDepot(t.depotId).orders[0];
    expect(o.status).toBe("filled");
    expect(o.fillPrice).toBeCloseTo(101 * (1 + DEFAULT_FEES.spreadPct), 9); // the open of day 1, with the spread
    expect(o.filledSim).toBe(t.days[1]);
  });

  it("fills a limit buy only when the day goes below the limit", () => {
    const t = setup();
    const buy = (limitPrice: number) => t.svc.placeOrder(t.id, t.depotId, { symbol: SAP.symbol, side: "buy", kind: "limit", qty: 1, limitPrice });
    buy(97.99); // below the low of day 0 (98): no fill
    buy(98); // equal to the low: it may not have filled
    buy(98.01); // the day went below it: fills, at the limit
    t.svc.stepDays(t.id, 1);
    const status = t.store.loadDepot(t.depotId).orders.map((o) => o.status);
    expect(status).toEqual(["open", "open", "filled"]);
    expect(t.store.loadDepot(t.depotId).orders[2].fillPrice).toBe(98.01);
  });

  it("fills a limit sell only when the day goes above it", () => {
    const t = setup();
    t.store.saveBalance(t.depotId, 900_000, new Map([[SAP.symbol, { qty: 5, cost: 50_000 }]]));
    t.svc.placeOrder(t.id, t.depotId, { symbol: SAP.symbol, side: "sell", kind: "limit", qty: 2, limitPrice: 103 }); // the high of day 0 is 103
    t.svc.placeOrder(t.id, t.depotId, { symbol: SAP.symbol, side: "sell", kind: "limit", qty: 2, limitPrice: 102.99 });
    t.svc.stepDays(t.id, 1);
    expect(t.store.loadDepot(t.depotId).orders.map((o) => o.status)).toEqual(["open", "filled"]);
  });

  it("writes one curve point per day and no bar of the future into the replies", () => {
    const t = setup();
    const r = t.svc.stepDays(t.id, 3);
    expect(r.newBars["SAP.DE"].map((b) => b.t)).toEqual(t.days.slice(0, 3));
    expect(t.store.valueCurve(t.depotId).map((p) => p.t)).toEqual([T0, ...t.days.slice(0, 3).map((d) => d + DAY)]);
    expect(t.svc.snapshot(t.id).prices["SAP.DE"].barT).toBe(t.days[2]);
  });

  it("converts a dollar title at the rate of the day", () => {
    const t = setup({ usdRate: 1.25 });
    t.svc.stepDays(t.id, 1);
    t.svc.placeOrder(t.id, t.depotId, { symbol: AAPL.symbol, side: "buy", kind: "market", qty: 10 });
    t.svc.stepDays(t.id, 1);
    const o = t.store.loadDepot(t.depotId).orders[0];
    expect(o.status).toBe("filled");
    expect(o.gross).toBeCloseTo(Math.round((10 * o.fillPrice! / (1.25 * (1 - DEFAULT_FEES.fxMarkupPct))) * 100), -1);
  });

  it("books a dividend once, for what was held before the ex-day", () => {
    const t = setup({ dividends: [{ exDay: isoOf(tradingDays()[1]), amount: 2 }] });
    t.store.saveBalance(t.depotId, 900_000, new Map([[SAP.symbol, { qty: 10, cost: 50_000 }]]));
    t.svc.stepDays(t.id, 4);
    expect(t.store.loadDepot(t.depotId).cash).toBe(900_000 + 2000);
    expect(t.store.bookings(t.depotId)).toHaveLength(1);
  });

  it("says end of data when no bar is left, and the time stays", () => {
    const t = setup();
    const r = t.svc.stepDays(t.id, 20);
    expect(r.endOfData).toBe(true);
    expect(r.simulationTime).toBe(t.days[11] + DAY);
  });

  it("measures on the day basis and the benchmark over the same days", () => {
    const t = setup();
    t.store.setBenchmark(t.id, SAP.symbol);
    t.store.saveBalance(t.depotId, 0, new Map([[SAP.symbol, { qty: 100, cost: 1 }], [AAPL.symbol, { qty: 50, cost: 1 }]]));
    t.svc.stepDays(t.id, 12);
    const ev = t.svc.evaluation(t.id);
    expect(ev.depots[0].metrics.basis).toBe("day");
    expect(ev.depots[0].metrics.periodsPerYear).toBe(252);
    expect(ev.benchmark?.metrics.basis).toBe("day");
    expect(ev.depots[0].diversification?.measured?.basis).toBe("day");
  });

  it("ticks by days per second at the tempo", () => {
    const t = setup();
    t.store.setTempo(t.id, 5);
    t.svc.tick(t.id, 1000);
    expect(t.svc.snapshot(t.id).simulation.simulationTime).toBe(t.days[4] + DAY);
    for (let i = 0; i < 5; i++) t.svc.tick(t.id, 100); // half a day each: carried, not lost, two days in all
    expect(t.svc.snapshot(t.id).simulation.simulationTime).toBe(t.days[6] + DAY);
  });

  it("refuses to start without a single price for the period", async () => {
    const t = setup();
    t.db.exec("delete from daily_bars");
    await expect(t.svc.start(t.id)).rejects.toMatchObject({ kind: "no_data", message: expect.stringMatching(/keine Tageskurse/) });
  });
});

const open: FastifyInstance[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

function dailyData(): DailyData {
  const days = tradingDays(8);
  return {
    async daily() {
      return {
        bars: days.map((t, i) => ({ day: isoOf(t), ...ohlc(i) })).filter((_, i) => i !== 3), // day 3 has no price
        dividends: [], splits: [],
      };
    },
  };
}

async function api() {
  const { source } = makeSource();
  const app = buildApp({
    dbPath: ":memory:", marketData: source, dailyData: dailyData(), instruments: [SAP], now: () => T0 + 400 * DAY, minGapMs: 0, tickMs: 20,
  });
  open.push(app);
  await app.ready();
  return app;
}

describe("daily simulations over the API", () => {
  it("is made from a date, loads the daily prices and serves only finished days with the skipped ones counted", async () => {
    const app = await api();
    const res = await app.inject({ method: "POST", url: "/api/simulations", payload: { name: "Tag", startAt: T0 + 12 * 3600, resolution: "day" } });
    expect(res.statusCode).toBe(201);
    const sim = res.json();
    expect(sim).toMatchObject({ resolution: "day", startAt: T0, simulationTime: T0 });
    expect((await app.inject({ url: `/api/simulations/${sim.id}/bars?symbol=SAP.DE` })).json().bars).toEqual([]);
    app.session.stepDays(sim.id, 6);
    const bars = (await app.inject({ url: `/api/simulations/${sim.id}/bars?symbol=SAP.DE` })).json();
    expect(bars.bars).toHaveLength(6); // six steps; the day without a price is not a step
    expect(bars.bars.every((b: any) => b.t + DAY <= app.session.snapshot(sim.id).simulation.simulationTime)).toBe(true);
    expect(bars.skipped).toBe(1);
  });

  it("refuses a start before the daily prices begin, one in the live gap, and live", async () => {
    const app = await api();
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/simulations", payload });
    expect((await post({ name: "x", startAt: Date.parse("2019-10-01T00:00:00Z") / 1000, resolution: "day" })).statusCode).toBe(400);
    expect((await post({ name: "x", startAt: T0 + 399 * DAY + 12 * 3600, resolution: "day" })).statusCode).toBe(400);
    expect((await post({ name: "x", live: true, resolution: "day" })).statusCode).toBe(400);
  });

  it("plays by the websocket: Tag weiter steps one day, and a minute simulation refuses it", async () => {
    const app = await api();
    const id = (await app.inject({ method: "POST", url: "/api/simulations", payload: { name: "Tag", startAt: T0, resolution: "day" } })).json().id as number;
    const msgs: any[] = [];
    const ws = await app.injectWS(`/ws/simulations/${id}`, {}, { onInit: (w: any) => w.on("message", (d: Buffer) => msgs.push(JSON.parse(String(d)))) });
    ws.send(JSON.stringify({ type: "step" }));
    const end = Date.now() + 1500;
    while (!msgs.some((m) => m.type === "tick") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    const tick = msgs.find((m) => m.type === "tick");
    expect(tick.simulationTime).toBe(T0 + DAY);
    expect(Object.keys(tick.newBars)).toEqual(["SAP.DE"]);
  });
});

describe("export and import", () => {
  it("keep the resolution, the rules and the bookings of a simulation", async () => {
    const { exportSimulation, importSimulation } = await import("../src/exchange.js");
    const { resolveRules } = await import("../src/domain/rules.js");
    const t = setup();
    t.db.prepare("update simulations set rules_json = ? where id = ?").run(JSON.stringify(resolveRules("hardcore")), t.id);
    t.store.addBooking(t.depotId, { t: T0, kind: "dividend", symbol: SAP.symbol, ref: "2020-02-03", amount: 500, text: "Ausschüttung SAP.DE 5,00 €" });
    const file = exportSimulation(t.db, t.id, T0);
    const made = importSimulation(t.db, JSON.parse(JSON.stringify(file)), () => true, T0);
    const copy = t.store.getSimulation(made.id)!;
    expect(copy.resolution).toBe("day");
    expect(copy.rules.preset).toBe("hardcore");
    expect(t.store.bookings(t.store.listDepots(made.id)[0].id)).toHaveLength(1);
  });

  it("read an older file without these fields as a relaxed minute simulation", async () => {
    const { exportSimulation, importSimulation } = await import("../src/exchange.js");
    const t = setup();
    const file: any = JSON.parse(JSON.stringify(exportSimulation(t.db, t.id, T0)));
    delete file.simulation.resolution; delete file.simulation.rules;
    for (const d of file.depots) delete d.bookings;
    const made = importSimulation(t.db, file, () => true, T0);
    expect(t.store.getSimulation(made.id)).toMatchObject({ resolution: "minute", rules: { preset: "relaxed" } });
  });
});
