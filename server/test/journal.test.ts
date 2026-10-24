import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data/marketdata.js";
import { type BarsAccess, type JournalOrder, buildJournal } from "../src/domain/journal.js";

const DAY = 86400;
const D0 = 1792627200; // 2026-10-22 00:00 UTC, a Thursday
const H = 3600;

/** One bar per day per symbol at 10:00 UTC, close given. A weekend has none. */
function access(closes: Record<string, [number, number][]>): BarsAccess & { calls: number[] } {
  const calls: number[] = [];
  const bars = (symbol: string): Bar[] =>
    (closes[symbol] ?? []).map(([t, c]) => ({ t, o: c, h: c, l: c, c, v: 1 }));
  return {
    calls,
    lastCompleteBar: (symbol, s) => {
      calls.push(s);
      return bars(symbol).filter((b) => b.t <= s - 60).at(-1);
    },
    nextBarAfter: (symbol, s) => bars(symbol).find((b) => b.t > s),
  };
}

let nextId = 1;
const order = (side: "buy" | "sell", qty: number, price: number, filledSim: number, extra: Partial<JournalOrder> = {}): JournalOrder => ({
  id: nextId++, symbol: "SAP.DE", side, qty, fillPrice: price, filledSim,
  gross: Math.round(qty * price * 100), commission: 100, foreignFee: 0, ...extra,
});

describe("buildJournal trades", () => {
  it("closes lots FIFO and splits fees by share", () => {
    nextId = 1;
    const b1 = order("buy", 10, 100, D0 + 10 * H); // gross 100000, fees 100 -> cost 100100
    const b2 = order("buy", 10, 110, D0 + 11 * H); // gross 110000 -> cost 110100
    const s1 = order("sell", 15, 120, D0 + 12 * H); // gross 180000, fees 100 -> proceeds 179900
    const j = buildJournal({ orders: [s1, b2, b1], s: D0 + 20 * H, bars: access({}), notes: {} });
    expect(j.trades.map((t) => t.key)).toEqual([`${s1.id}:${b1.id}`, `${s1.id}:${b2.id}`]);
    const [t1, t2] = j.trades;
    expect(t1).toMatchObject({ qty: 10, buyCost: 100100, sellProceeds: 119933, openedSim: D0 + 10 * H, closedSim: D0 + 12 * H, holdSeconds: 2 * H });
    expect(t1.netPnl).toBe(119933 - 100100);
    expect(t2).toMatchObject({ qty: 5, buyCost: 55050, sellProceeds: 59967 });
    // the sale's proceeds are handed out exactly, with no cent lost
    expect(t1.sellProceeds + t2.sellProceeds).toBe(179900);
    expect(j.open).toEqual([{ symbol: "SAP.DE", qty: 5, cost: 55050, openedSim: D0 + 11 * H }]);
  });

  it("counts fees of a USD trade as the broker booked them (foreign fee included), in cents", () => {
    nextId = 1;
    const b = order("buy", 1, 200, D0 + H, { symbol: "AAPL", gross: 18000, commission: 490, foreignFee: 1490 });
    const s = order("sell", 1, 210, D0 + 2 * H, { symbol: "AAPL", gross: 19000, commission: 490, foreignFee: 1490 });
    const j = buildJournal({ orders: [b, s], s: D0 + 3 * H, bars: access({}), notes: {} });
    expect(j.trades[0]).toMatchObject({ buyCost: 19980, sellProceeds: 17020, netPnl: -2960, fees: 3960 });
  });

  it("measures hit rate after fees with n and basis, and null without trades", () => {
    nextId = 1;
    const empty = buildJournal({ orders: [], s: D0, bars: access({}), notes: {} });
    expect(empty.hitRate).toMatchObject({ n: 0, wins: 0, rate: null });
    expect(empty.holding).toMatchObject({ n: 0, medianSeconds: null, meanSeconds: null });
    expect(empty.fewData).toBe(true);

    // gross win of 0.50 per share is eaten by the fees: not a win
    const b = order("buy", 1, 100, D0 + H);
    const s = order("sell", 1, 100.5, D0 + 2 * H, { gross: 10050 });
    const j = buildJournal({ orders: [b, s], s: D0 + 3 * H, bars: access({}), notes: {} });
    expect(j.trades[0].netPnl).toBeLessThan(0);
    expect(j.hitRate).toMatchObject({ n: 1, wins: 0, rate: 0 });
    expect(j.hitRate.basis).toMatch(/Gebühren/);
    expect(j.fewData).toBe(true);
  });

  it("gives median and mean of the holding time and flags under 5 trades as few data", () => {
    nextId = 1;
    const orders: JournalOrder[] = [];
    for (const [k, hold] of [[0, 1], [1, 2], [2, 6]] as const) {
      orders.push(order("buy", 1, 100, D0 + k * DAY + H), order("sell", 1, 110, D0 + k * DAY + H + hold * H, { gross: 11000 }));
    }
    const j = buildJournal({ orders, s: D0 + 10 * DAY, bars: access({}), notes: {} });
    expect(j.trades).toHaveLength(3);
    expect(j.holding).toMatchObject({ n: 3, medianSeconds: 2 * H, meanSeconds: 3 * H });
    expect(j.fewData).toBe(true);
    for (let k = 3; k < 5; k++) orders.push(order("buy", 1, 100, D0 + k * DAY + H), order("sell", 1, 110, D0 + k * DAY + 2 * H, { gross: 11000 }));
    expect(buildJournal({ orders, s: D0 + 10 * DAY, bars: access({}), notes: {} }).fewData).toBe(false);
  });

  it("joins notes by trade key and ignores a sell without lots", () => {
    nextId = 1;
    const b = order("buy", 1, 100, D0 + H);
    const s = order("sell", 1, 110, D0 + 2 * H, { gross: 11000 });
    const orphan = order("sell", 1, 110, D0 + 3 * H, { gross: 11000 });
    const j = buildJournal({ orders: [b, s, orphan], s: D0 + 4 * H, bars: access({}), notes: { [`${s.id}:${b.id}`]: "zu nervös" } });
    expect(j.trades).toHaveLength(1);
    expect(j.trades[0].note).toBe("zu nervös");
  });
});

describe("buildJournal too early", () => {
  // Sale on Thursday D0 at 100. Closes: Fri 103, Mon 98, Tue 99, Wed 100, Thu 120.
  const closes: [number, number][] = [
    [D0 + 10 * H, 100],
    [D0 + DAY + 10 * H, 103], // Fri
    [D0 + 4 * DAY + 10 * H, 98], // Mon
    [D0 + 5 * DAY + 10 * H, 99],
    [D0 + 6 * DAY + 10 * H, 100],
    [D0 + 7 * DAY + 10 * H, 120], // Thu, the 5th trading day after the sale
    [D0 + 8 * DAY + 10 * H, 50], // Fri, the 6th: must not be used
  ];
  const sale = () => {
    nextId = 1;
    return [order("buy", 1, 90, D0 + 9 * H), order("sell", 1, 100, D0 + 12 * H, { gross: 10000 })];
  };

  it("uses the close of the 1st and 5th trading day after the sale, and calls more than 2 % higher too early", () => {
    const j = buildJournal({ orders: sale(), s: D0 + 20 * DAY, bars: access({ "SAP.DE": closes }), notes: {} });
    const [x] = j.sales;
    expect(x).toMatchObject({ symbol: "SAP.DE", price: 100, soldSim: D0 + 12 * H });
    expect(x.horizons[0]).toMatchObject({ days: 1, status: "done", laterClose: 103, movePct: 3, tooEarly: true });
    expect(x.horizons[1]).toMatchObject({ days: 5, status: "done", laterClose: 120, movePct: 20, tooEarly: true });
    expect(j.tooEarly[0]).toMatchObject({ days: 1, n: 1, count: 1, rate: 1, avgMovePct: 3 });
    expect(j.tooEarly[1]).toMatchObject({ days: 5, n: 1, count: 1, rate: 1, avgMovePct: 20 });
    expect(j.tooEarly[0].basis).toMatch(/2 %/);
  });

  it("exactly 2 % higher is not too early", () => {
    const j = buildJournal({
      orders: sale(), s: D0 + 20 * DAY, bars: access({ "SAP.DE": [[D0 + DAY + 10 * H, 102]] }), notes: {},
    });
    expect(j.sales[0].horizons[0]).toMatchObject({ status: "done", laterClose: 102, tooEarly: false });
  });

  it("never looks beyond the simulation clock: a horizon not reached is open and does not count", () => {
    const a = access({ "SAP.DE": closes });
    // Friday 12:00: the bar of Friday is complete, but the day is not over, so the 1-day horizon is open.
    const midFriday = buildJournal({ orders: sale(), s: D0 + DAY + 12 * H, bars: a, notes: {} });
    expect(midFriday.sales[0].horizons[0]).toMatchObject({ status: "open" });
    expect(midFriday.sales[0].horizons[0].laterClose).toBeUndefined();
    expect(midFriday.tooEarly[0]).toMatchObject({ n: 0, count: 0, rate: null, avgMovePct: null, open: 1 });
    // Tuesday 00:00: Friday and Monday are over, so the 1-day horizon is done and the 5-day one is open.
    const tuesday = D0 + 5 * DAY;
    const b = access({ "SAP.DE": closes });
    const monday = buildJournal({ orders: sale(), s: tuesday, bars: b, notes: {} });
    expect(monday.sales[0].horizons[0]).toMatchObject({ status: "done", laterClose: 103 });
    expect(monday.sales[0].horizons[1]).toMatchObject({ status: "open" });
    // the lookup was never asked about a time after the clock
    for (const t of b.calls) expect(t).toBeLessThanOrEqual(tuesday);
    expect(a.calls).toEqual([]);
  });

  it("does not use a future bar even if the lookup hands one over", () => {
    // A lookup that ignores the clock: the module must still not take bars that are not finished at s.
    const leaky: BarsAccess = {
      lastCompleteBar: () => ({ t: D0 + 8 * DAY, o: 500, h: 500, l: 500, c: 500, v: 1 }),
      nextBarAfter: (_s, t) => ({ t: Math.floor(t / DAY + 1) * DAY + 10 * H, o: 500, h: 500, l: 500, c: 500, v: 1 }),
    };
    const j = buildJournal({ orders: sale(), s: D0 + 14 * H, bars: leaky, notes: {} });
    expect(j.sales[0].horizons.every((h) => h.status === "open")).toBe(true);
  });

  it("is open when no later trading day is known", () => {
    const j = buildJournal({ orders: sale(), s: D0 + 20 * DAY, bars: access({}), notes: {} });
    expect(j.sales[0].horizons.map((h) => h.status)).toEqual(["open", "open"]);
  });
});
