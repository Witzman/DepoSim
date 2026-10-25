import { describe, expect, it } from "vitest";
import { createArchive } from "../src/data/archive.js";
import { openDb } from "../src/db.js";
import { DEFAULT_FEES } from "../src/domain/fees.js";
import { applySplit, dividendCredit, showsSplit, splitOrder } from "../src/domain/events.js";
import { simulateLongterm } from "../src/domain/longterm.js";
import { type Events, createEvents } from "../src/events.js";
import { MarketDataError } from "../src/data/marketdata.js";
import { InstrumentRegistry } from "../src/instruments.js";
import { SessionService } from "../src/session.js";
import { createStore } from "../src/store.js";
import { AAPL, D0, D1, FX, H, SAP, bar, makeSource } from "./fakes.js";

const DAY1 = new Date(D1 * 1000).toISOString().slice(0, 10);

type Div = { exDay: string; amount: number };
type Split = { day: string; numerator: number; denominator: number };

function setup(opts: { dividends?: Div[]; splits?: Split[]; afterSplit?: number } = {}) {
  const { source, all } = makeSource();
  if (opts.afterSplit !== undefined) {
    // The second day is quoted after a split: no jump hidden, the prices really fall.
    all[SAP.symbol] = [...all[SAP.symbol].filter((b) => b.t < D1), ...Array.from({ length: 10 }, (_, i) => bar(D1 + 7 * H + i * 60, opts.afterSplit! + i * 0.01))];
  }
  const db = openDb(":memory:");
  const store = createStore(db);
  const archive = createArchive(db, source, { now: () => D1 + DAY_PLUS, minGapMs: 0 });
  const events: Events = {
    ensure: async () => {},
    dividends: (symbol, from, to) => (symbol === SAP.symbol ? (opts.dividends ?? []).filter((d) => d.exDay >= from && d.exDay <= to) : []),
    splits: (symbol, from, to) => (symbol === SAP.symbol ? (opts.splits ?? []).filter((s) => s.day >= from && s.day <= to) : []),
  };
  const registry = new InstrumentRegistry(db, [SAP, AAPL]);
  const make = () => new SessionService({ store, archive, instruments: registry, fxSymbol: FX, now: () => D1 + DAY_PLUS, events });
  const svc = make();
  // The end of the first trading day, holding 10 SAP.DE.
  const sim = store.createSimulation({ name: "E", startAt: D0 + 8 * H, startCash: 1_000_000, fees: DEFAULT_FEES });
  const depotId = store.listDepots(sim.id)[0].id;
  store.saveBalance(depotId, 1_000_000 - 61_000, new Map([[SAP.symbol, { qty: 10, cost: 61_000 }]]));
  return { db, store, archive, svc, make, id: sim.id, depotId, all };
}
const DAY_PLUS = 86400;

async function crossIntoDay1(t: ReturnType<typeof setup>, svc: SessionService = t.svc) {
  for (const symbol of [SAP.symbol, AAPL.symbol, FX]) {
    await t.archive.ensureDay(symbol, D0);
    await t.archive.ensureDay(symbol, D1);
  }
  svc.setTempo(t.id, 60);
  for (let i = 0; i < 6; i++) svc.tick(t.id, 60_000);
}

describe("dividends in the simulation", () => {
  it("credits shares x amount once the clock passes the ex-day, and not before", async () => {
    const t = setup({ dividends: [{ exDay: DAY1, amount: 1.25 }] });
    await t.archive.ensureDay(SAP.symbol, D0);
    expect(t.svc.snapshot(t.id).depots[0].cash).toBe(1_000_000 - 61_000);
    await crossIntoDay1(t);
    expect(t.store.loadDepot(t.depotId).cash).toBe(1_000_000 - 61_000 + 1250);
    expect(t.store.bookings(t.depotId)).toEqual([
      expect.objectContaining({ kind: "dividend", symbol: SAP.symbol, ref: DAY1, amount: 1250, text: "Ausschüttung SAP.DE 12,50 €" }),
    ]);
  });

  it("books exactly once, also after more ticks and after a restart of the service", async () => {
    const t = setup({ dividends: [{ exDay: DAY1, amount: 1.25 }] });
    await crossIntoDay1(t);
    const fresh = t.make();
    for (let i = 0; i < 4; i++) fresh.tick(t.id, 60_000);
    expect(t.store.bookings(t.depotId)).toHaveLength(1);
    expect(t.store.loadDepot(t.depotId).cash).toBe(1_000_000 - 61_000 + 1250);
    // A second write for the same ex-day is refused by the table itself.
    expect(t.store.addBooking(t.depotId, { t: D1, kind: "dividend", symbol: SAP.symbol, ref: DAY1, amount: 1250, text: "x" })).toBe(false);
  });

  it("gives nothing to a depot that held no shares, and counts the value curve only once", async () => {
    const t = setup({ dividends: [{ exDay: DAY1, amount: 1.25 }] });
    t.store.saveBalance(t.depotId, 1_000_000, new Map());
    await crossIntoDay1(t);
    expect(t.store.bookings(t.depotId)).toEqual([]);
    expect(t.store.loadDepot(t.depotId).cash).toBe(1_000_000);
  });

  it("pays the same as the long-term comparison for the same shares", () => {
    // One share at 1000 EUR from 1500 EUR cash: the distribution cannot buy a second one, so the shares stay the same.
    const bars = [{ day: "2026-01-02", o: 1000, c: 1000 }, { day: "2026-01-05", o: 1000, c: 1000 }, { day: "2026-01-06", o: 1000, c: 1000 }];
    const r = simulateLongterm({ bars, dividends: [{ exDay: "2026-01-05", amount: 12.34 }], startDay: "2026-01-02", startCash: 150_000, fees: DEFAULT_FEES });
    expect(r.shares).toBe(1);
    expect(r.reinvestments).toBe(0);
    expect(r.dividendsReceived).toBe(dividendCredit(1, 12.34));
  });

  it("converts a dollar distribution at the rate of the day", () => {
    expect(dividendCredit(10, 0.55, 1.1)).toBe(500);
    expect(dividendCredit(3, 1.37)).toBe(411);
  });
});

describe("splits", () => {
  const FOUR = [{ day: DAY1, numerator: 4, denominator: 1 }];

  it("recognises a split in the bars by the price jump, and not when the history is adjusted", () => {
    expect(showsSplit(61, 15.25, 4, 1)).toBe(true);
    expect(showsSplit(61, 60.5, 4, 1)).toBe(false);
    expect(showsSplit(0, 15, 4, 1)).toBe(false);
  });

  it("multiplies the shares and keeps the cost, so the depot is worth the same before and after", async () => {
    const t = setup({ splits: FOUR, afterSplit: 15.5 });
    const before = t.svc.snapshot(t.id).depots[0];
    await crossIntoDay1(t);
    const state = t.store.loadDepot(t.depotId);
    expect(state.positions.get(SAP.symbol)).toEqual({ qty: 40, cost: 61_000 });
    const after = t.svc.snapshot(t.id).depots[0];
    expect(t.store.bookings(t.depotId)).toEqual([expect.objectContaining({ kind: "split", ref: DAY1 })]);
    // 10 x 61 EUR before; 40 x ~15.5 EUR after (the bar prices wiggle by a cent)
    expect(Math.abs(after.value - before.value) / before.value).toBeLessThan(0.02);
  });

  it("splits only once", async () => {
    const t = setup({ splits: FOUR, afterSplit: 15.5 });
    await crossIntoDay1(t);
    const fresh = t.make();
    for (let i = 0; i < 4; i++) fresh.tick(t.id, 60_000);
    expect(t.store.loadDepot(t.depotId).positions.get(SAP.symbol)?.qty).toBe(40);
  });

  it("leaves the shares alone when the bars show no jump", async () => {
    const t = setup({ splits: FOUR });
    await crossIntoDay1(t);
    expect(t.store.loadDepot(t.depotId).positions.get(SAP.symbol)?.qty).toBe(10);
    expect(t.store.bookings(t.depotId)).toEqual([]);
  });

  it("pays out a fraction of a share and takes its cost along", () => {
    const state = { cash: 0, positions: new Map([["X", { qty: 3, cost: 900 }]]), orders: [] };
    expect(applySplit(state, "X", 3, 2, 10)).toEqual({ qty: 4, cashOut: 500 }); // 4.5 shares: half a share at 10 EUR
    expect(state.cash).toBe(500);
    expect(state.positions.get("X")).toEqual({ qty: 4, cost: 800 });
  });

  it("scales an open limit order", () => {
    expect(splitOrder(5, 80, 4, 1)).toEqual({ qty: 20, limitPrice: 20 });
    expect(splitOrder(3, undefined, 1, 2)).toEqual({ qty: 1, limitPrice: undefined });
  });

  it("scales the open limit order of the depot", async () => {
    const t = setup({ splits: FOUR, afterSplit: 15.5 });
    await t.archive.ensureDay(SAP.symbol, D0);
    t.svc.placeOrder(t.id, t.depotId, { symbol: SAP.symbol, side: "sell", kind: "limit", qty: 5, limitPrice: 80 });
    await crossIntoDay1(t);
    const o = t.store.loadDepot(t.depotId).orders.find((x) => x.kind === "limit")!;
    expect(o.qty).toBe(20);
    expect(o.limitPrice).toBe(20);
  });
});

describe("events repository", () => {
  const series = { bars: [], dividends: [{ exDay: "2026-10-23", amount: 1.1 }], splits: [{ day: "2026-10-23", numerator: 4, denominator: 1 }] };

  it("stores what the source gives, reads it by day, and asks again only after twelve hours", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    let now = 1_000_000;
    const events = createEvents({ db, now: () => now, source: { daily: async () => (calls++, series) } });
    await events.ensure("SAP.DE");
    await events.ensure("SAP.DE");
    expect(calls).toBe(1);
    expect(events.dividends("SAP.DE", "2026-10-23", "2026-10-23")).toEqual([{ exDay: "2026-10-23", amount: 1.1 }]);
    expect(events.dividends("SAP.DE", "2026-10-24", "2026-10-30")).toEqual([]);
    expect(events.splits("SAP.DE", "2026-10-01", "2026-10-31")).toEqual([{ day: "2026-10-23", numerator: 4, denominator: 1 }]);
    now += 13 * 3600;
    await events.ensure("SAP.DE");
    expect(calls).toBe(2);
  });

  it("does not throw on a failure and tries again next time, but remembers a symbol without data", async () => {
    const db = openDb(":memory:");
    const errors: MarketDataError[] = [new MarketDataError("rate_limited", "x"), new MarketDataError("no_data", "y")];
    let calls = 0;
    const events = createEvents({ db, now: () => 1, source: { daily: async () => { calls++; throw errors.shift() ?? new Error("more"); } } });
    await expect(events.ensure("A")).resolves.toBeUndefined();
    await events.ensure("A"); // rate limit: asked again, now no_data
    await events.ensure("A"); // no_data is remembered
    expect(calls).toBe(2);
  });
});
