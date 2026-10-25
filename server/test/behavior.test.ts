import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data/marketdata.js";
import { analyzeBehavior, MIN_BEHAVIOR_TRADES } from "../src/domain/behavior.js";
import { type BarsAccess, type JournalOrder, type JournalTrade, type SaleContext, buildJournalCore } from "../src/domain/journal.js";

const DAY = 86400;
const H = 3600;
const D0 = 1792627200; // 2026-10-22 00:00 UTC

/** One bar per day per symbol at 10:00 UTC; the table gives [day index, close]. */
function access(closes: Record<string, [number, number][]>): BarsAccess & { asked: number[] } {
  const asked: number[] = [];
  const bars = (symbol: string): Bar[] => (closes[symbol] ?? []).map(([d, c]) => ({ t: D0 + d * DAY + 10 * H, o: c, h: c, l: c, c, v: 1 }));
  return {
    asked,
    lastCompleteBar: (symbol, s) => { asked.push(s); return bars(symbol).filter((b) => b.t <= s - 60).at(-1); },
    nextBarAfter: (symbol, s) => bars(symbol).find((b) => b.t > s),
  };
}

let nextId = 1;
const order = (side: "buy" | "sell", qty: number, price: number, filledSim: number, extra: Partial<JournalOrder> = {}): JournalOrder => ({
  id: nextId++, symbol: "SAP.DE", side, qty, fillPrice: price, filledSim, gross: Math.round(qty * price * 100), commission: 100, foreignFee: 0, ...extra,
});
const trade = (n: number, netPnl: number, holdSeconds = H, sellOrderId = n): JournalTrade => ({
  key: `${sellOrderId}:0`, symbol: "SAP.DE", qty: 1, buyOrderId: 0, sellOrderId, openedSim: D0 + 10 * H, closedSim: D0 + 10 * H + holdSeconds, holdSeconds,
  buyPrice: 1, sellPrice: 1, buyCost: 1, sellProceeds: 1, fees: 100, netPnl, netPct: null, note: null,
});
const many = (n: number, f: (i: number) => JournalTrade) => Array.from({ length: n }, (_, i) => f(i));
const base = { orders: [] as JournalOrder[], contexts: [] as SaleContext[], s: D0 + 30 * DAY, meanValue: null, intraday: true };

describe("disposition effect", () => {
  it("counts realized against paper gains and losses on the day of each sale (3 of 5 gains, 1 of 5 losses: ratio 3)", () => {
    const bars = access({ G1: [[0, 120]], G2: [[0, 130]], L1: [[0, 80]], L2: [[0, 70]], L3: [[0, 60]], L4: [[0, 50]] });
    const lot = (symbol: string) => ({ symbol, qty: 1, buyPrice: 100 });
    const ctx: SaleContext = {
      orderId: 1, symbol: "SAP.DE", soldSim: D0 + DAY, // after the bars
      closed: [{ buyPrice: 100, sellPrice: 110, qty: 1 }, { buyPrice: 100, sellPrice: 120, qty: 1 }, { buyPrice: 100, sellPrice: 105, qty: 1 }, { buyPrice: 100, sellPrice: 90, qty: 1 }],
      remaining: [lot("G1"), lot("G2"), lot("L1"), lot("L2"), lot("L3"), lot("L4")],
    };
    const r = analyzeBehavior({ ...base, bars, trades: many(10, (i) => trade(i, 1)), contexts: [ctx] }).disposition;
    expect(r).toMatchObject({ realizedGains: 3, realizedLosses: 1, paperGains: 2, paperLosses: 4, pgr: 0.6, plr: 0.2, ratio: 3, ok: true });
  });

  it("leaves a lot out when no price is known and says how many", () => {
    const ctx: SaleContext = { orderId: 1, symbol: "A", soldSim: D0 + DAY, closed: [{ buyPrice: 1, sellPrice: 2, qty: 1 }], remaining: [{ symbol: "NOPE", qty: 1, buyPrice: 1 }] };
    const r = analyzeBehavior({ ...base, bars: access({}), trades: many(10, (i) => trade(i, 1)), contexts: [ctx] }).disposition;
    expect(r.unpriced).toBe(1);
    expect(r.pgr).toBe(1);
    expect(r.ok).toBe(false); // no loss side: no ratio
  });

  it("never asks the archive past the simulation time", () => {
    const bars = access({ X: [[0, 100]] });
    const ctx: SaleContext = { orderId: 1, symbol: "A", soldSim: D0 + 50 * DAY, closed: [], remaining: [{ symbol: "X", qty: 1, buyPrice: 90 }] };
    analyzeBehavior({ ...base, s: D0 + 5 * DAY, bars, trades: [], contexts: [ctx] });
    expect(Math.max(...bars.asked)).toBeLessThanOrEqual(D0 + 5 * DAY);
  });

  it("gives no figures under the minimum number of trades", () => {
    const ctx: SaleContext = { orderId: 1, symbol: "A", soldSim: D0 + DAY, closed: [{ buyPrice: 1, sellPrice: 2, qty: 1 }, { buyPrice: 2, sellPrice: 1, qty: 1 }], remaining: [] };
    const b = analyzeBehavior({ ...base, bars: access({}), trades: many(MIN_BEHAVIOR_TRADES - 1, (i) => trade(i, 1)), contexts: [ctx] });
    expect(b.disposition.ok).toBe(false);
    expect(b.holding.ok).toBe(false);
    expect(b.turnover.ok).toBe(false);
  });
});

describe("holding, turnover, after a loss", () => {
  it("compares the median hold of winners and losers", () => {
    const trades = [
      ...many(5, (i) => trade(i, 100, 1 * H)),
      ...many(5, (i) => trade(10 + i, -100, 4 * H)),
    ];
    const h = analyzeBehavior({ ...base, bars: access({}), trades }).holding;
    expect(h).toMatchObject({ ok: true, winners: { n: 5, medianSeconds: H }, losers: { n: 5, medianSeconds: 4 * H } });
  });

  it("orders per month, yearly turnover over the mean depot, fees per trade and their share of the gross result", () => {
    nextId = 1;
    const orders = [order("buy", 10, 100, D0), order("sell", 10, 110, D0 + 10 * DAY), order("buy", 10, 100, D0 + 20 * DAY)];
    const trades = many(10, (i) => trade(i, 900)); // fees 100 each, gross 1000 each
    const s = D0 + 30.4375 * DAY * 2; // two months
    const t = analyzeBehavior({ ...base, s, orders, bars: access({}), trades, meanValue: 100000 }).turnover;
    expect(t.orders).toBe(3);
    expect(t.ordersPerMonth).toBe(1.5);
    expect(t.feesPerTrade).toBe(100);
    expect(t.feeShare).toBe(0.1);
    // buys: 2 x 100000 cents over 1/6 year, over a mean depot of 100000
    expect(t.yearlyTurnover).toBeCloseTo(12, 1);
  });

  it("shows no rate under a month of history", () => {
    nextId = 1;
    const t = analyzeBehavior({ ...base, s: D0 + 5 * DAY, orders: [order("buy", 1, 1, D0)], bars: access({}), trades: [] }).turnover;
    expect(t.ordersPerMonth).toBeNull();
    expect(t.yearlyTurnover).toBeNull();
  });

  it("measures the next order after a loss against all orders: sooner and larger", () => {
    nextId = 1;
    const orders: JournalOrder[] = [];
    const trades: JournalTrade[] = [];
    let t = D0;
    for (let i = 0; i < 4; i++) {
      const sell = order("sell", 1, 90, t);
      orders.push(sell);
      trades.push(trade(i, -500, H, sell.id));
      orders.push(order("buy", 5, 100, t + 600)); // ten minutes later, bigger
      t += 5 * DAY;
      orders.push(order("buy", 1, 100, t - H)); // an ordinary small one, far from any loss
    }
    const a = analyzeBehavior({ ...base, orders, trades: [...trades, ...many(6, (i) => trade(20 + i, 100))], bars: access({}) }).afterLoss;
    expect(a.n).toBe(4);
    expect(a.medianGapSeconds).toBe(600);
    expect(a.medianSize).toBe(50000);
    expect(a.baselineSize).toBeLessThan(a.medianSize!);
    expect(a.ok).toBe(true);
  });
});

describe("chasing", () => {
  it("splits buys into after a rise of more than 5 % in 5 trading days and after a dip", () => {
    nextId = 1;
    const closes = { SAP: [[0, 100], [1, 101], [2, 100], [3, 100], [4, 100], [5, 100], [6, 100], [7, 100]] as [number, number][] };
    // day 7 buys: reference is the close of day 2 (5 trading days before): 100
    const orders = [
      ...many(6, () => order("buy", 1, 110, D0 + 7 * DAY + 11 * H, { symbol: "SAP" })), // +10 %
      ...many(3, () => order("buy", 1, 95, D0 + 7 * DAY + 12 * H, { symbol: "SAP" })), // dip
      order("buy", 1, 102, D0 + 7 * DAY + 13 * H, { symbol: "SAP" }), // neither
      order("buy", 1, 100, D0 + 3 * DAY, { symbol: "SAP" }), // too early in the archive: no reference
    ];
    const c = analyzeBehavior({ ...base, orders, bars: access(closes), trades: [] }).chasing;
    expect(c).toMatchObject({ n: 10, momentum: 6, pullback: 3, momentumShare: 0.6, pullbackShare: 0.3, ok: true });
  });
});

describe("time of day", () => {
  it("is refused for a daily simulation and under 20 trades, and otherwise lists the Berlin hours", () => {
    const daily = analyzeBehavior({ ...base, bars: access({}), trades: many(25, (i) => trade(i, 1)), intraday: false }).timeOfDay;
    expect(daily.ok).toBe(false);
    expect(daily.reason).toMatch(/Tageskurs/);
    const few = analyzeBehavior({ ...base, bars: access({}), trades: many(19, (i) => trade(i, 1)) }).timeOfDay;
    expect(few.ok).toBe(false);
    const ok = analyzeBehavior({ ...base, bars: access({}), trades: many(20, (i) => trade(i, i % 2 ? 1 : -1)) }).timeOfDay;
    expect(ok.ok).toBe(true);
    // 10:00 UTC on 2026-10-22 is 12:00 in Berlin (CEST)
    expect(ok.hours).toEqual([{ hour: 12, n: 20, wins: 10, netPnl: 0 }]);
  });
});

describe("time of day by venue", () => {
  it("reads the hour in the zone of the venue the symbol trades on", () => {
    const us = many(10, (i) => ({ ...trade(i, 1), symbol: "AAPL", openedSim: D0 + 14 * H + 30 * 60 })); // 14:30 UTC = 10:30 in New York (EDT)
    const de = many(10, (i) => ({ ...trade(20 + i, 1), symbol: "SAP.DE", openedSim: D0 + 10 * H })); // 10:00 UTC = 12:00 in Berlin (CEST)
    const zoneOf = (symbol: string) => (symbol === "AAPL" ? "America/New_York" : "Europe/Berlin");
    const r = analyzeBehavior({ ...base, bars: access({}), trades: [...us, ...de], zoneOf }).timeOfDay;
    expect(r.hours.map((h) => [h.hour, h.n])).toEqual([[10, 10], [12, 10]]);
  });
});

describe("buildJournalCore contexts", () => {
  it("hands out per sale the closed pieces and the lots still open, all in own prices", () => {
    nextId = 1;
    const orders = [
      order("buy", 10, 100, D0 + H), order("buy", 5, 50, D0 + 2 * H, { symbol: "ALV.DE" }),
      order("sell", 4, 120, D0 + 3 * H),
    ];
    const { contexts, journal } = buildJournalCore({ orders, s: D0 + DAY, bars: access({}), notes: {} });
    expect(journal.trades).toHaveLength(1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].closed).toEqual([{ buyPrice: 100, sellPrice: 120, qty: 4 }]);
    expect(contexts[0].remaining).toEqual([
      { symbol: "SAP.DE", qty: 6, buyPrice: 100 }, { symbol: "ALV.DE", qty: 5, buyPrice: 50 },
    ]);
  });
});
