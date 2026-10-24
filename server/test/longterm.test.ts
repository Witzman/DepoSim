import { describe, expect, it } from "vitest";
import { DEFAULT_FEES, type FeeConfig, previewCost } from "../src/domain/fees.js";
import { type DailyBar, simulateLongterm } from "../src/domain/longterm.js";

// Round numbers on purpose: 1 % commission, minimum 1.00 EUR, no spread, so the sums are done by hand.
const FEES: FeeConfig = { ...DEFAULT_FEES, commissionPct: 0.01, commissionMin: 100, commissionMax: 5000, spreadPct: 0 };

const bar = (day: string, o: number, c = o): DailyBar => ({ day, o, c });
const START = { startDay: "2019-11-01", startCash: 100000, fees: FEES };

describe("simulateLongterm", () => {
  it("buys at the open of the first day on or after the start day, whole shares, rest stays cash", () => {
    // 10.00 EUR: 99 shares = 99000 + 990 commission = 99990 <= 100000; 100 shares = 100000 + 1000 does not fit.
    const r = simulateLongterm({
      ...START,
      startDay: "2019-11-02", // a Saturday: the first bar after it is Monday the 4th
      bars: [bar("2019-11-01", 9), bar("2019-11-04", 10, 11), bar("2019-11-05", 10, 12)],
      dividends: [],
    });
    expect(r.firstBuyDay).toBe("2019-11-04");
    expect(r.shares).toBe(99);
    expect(r.leftoverCash).toBe(10);
    expect(r.feesPaid).toBe(990);
    expect(r.points).toEqual([
      { day: "2019-11-04", value: 99 * 1100 + 10 },
      { day: "2019-11-05", value: 99 * 1200 + 10 },
    ]);
    expect(r.finalValue).toBe(99 * 1200 + 10);
    expect(r.totalReturn).toBeCloseTo((118810 - 100000) / 100000, 10);
    expect(r.dividendsReceived).toBe(0);
    expect(r.reinvestments).toBe(0);
  });

  it("reinvests a dividend at the next trading day's open, with commission, rest carried", () => {
    const r = simulateLongterm({
      ...START,
      bars: [bar("2019-11-01", 10), bar("2019-11-04", 10, 11), bar("2019-11-05", 11), bar("2019-11-06", 12, 12.5)],
      // 99 shares x 0.50 = 49.50 EUR = 4950 cent on 2019-11-05; cash 10 + 4950 = 4960.
      dividends: [{ exDay: "2019-11-05", amount: 0.5 }],
    });
    // Day 3 open 12.00: 4 shares = 4800 + 100 (minimum) = 4900; 5 shares = 6000 + 100 does not fit.
    expect(r.dividendsReceived).toBe(4950);
    expect(r.reinvestments).toBe(1);
    expect(r.shares).toBe(103);
    expect(r.leftoverCash).toBe(60);
    expect(r.feesPaid).toBe(990 + 100);
    expect(r.finalValue).toBe(103 * 1250 + 60);
    expect(r.points.map((p) => p.value)).toEqual([99 * 1000 + 10, 99 * 1100 + 10, 99 * 1100 + 10 + 4950, 103 * 1250 + 60]);
  });

  it("a dividend below the minimum commission stays cash until a later one makes a buy possible", () => {
    const r = simulateLongterm({
      ...START,
      bars: [
        bar("2019-11-01", 10), bar("2019-11-04", 10), bar("2019-11-05", 12),
        bar("2019-11-06", 12), bar("2019-11-07", 12), bar("2019-11-08", 12),
      ],
      // 99 x 0.01 = 0.99 EUR = 99 cent, under the 100 cent minimum: nothing can be bought.
      // Later 99 x 0.50 = 4950 cent: 10 + 99 + 4950 = 5059 -> 4 shares for 4900, 159 left.
      dividends: [{ exDay: "2019-11-05", amount: 0.01 }, { exDay: "2019-11-07", amount: 0.5 }],
    });
    expect(r.dividendsReceived).toBe(99 + 4950);
    expect(r.reinvestments).toBe(1);
    expect(r.skippedReinvestments).toBe(1);
    expect(r.shares).toBe(103);
    expect(r.leftoverCash).toBe(159);
    expect(r.feesPaid).toBe(990 + 100);
  });

  it("an ex-day without a bar still pays; the buy comes on the next bar after it", () => {
    const r = simulateLongterm({
      ...START,
      bars: [bar("2019-11-01", 10), bar("2019-11-04", 10), bar("2019-11-08", 12)], // 2019-11-06 has no bar
      dividends: [{ exDay: "2019-11-06", amount: 0.5 }],
    });
    expect(r.dividendsReceived).toBe(4950);
    expect(r.reinvestments).toBe(1);
    expect(r.points[2]).toEqual({ day: "2019-11-08", value: 103 * 1200 + 60 });
  });

  it("shares bought on the ex-day itself get no dividend, and one before the first buy is ignored", () => {
    const r = simulateLongterm({
      ...START,
      bars: [bar("2019-11-04", 10), bar("2019-11-05", 10)],
      dividends: [{ exDay: "2019-11-01", amount: 5 }, { exDay: "2019-11-04", amount: 5 }],
    });
    expect(r.dividendsReceived).toBe(0);
    expect(r.reinvestments).toBe(0);
  });

  it("a dividend on the last day cannot be reinvested: it is reported as cash", () => {
    const r = simulateLongterm({
      ...START,
      bars: [bar("2019-11-01", 10), bar("2019-11-04", 10)],
      dividends: [{ exDay: "2019-11-04", amount: 0.5 }],
    });
    expect(r.dividendsReceived).toBe(4950);
    expect(r.reinvestments).toBe(0);
    expect(r.leftoverCash).toBe(4960);
    expect(r.finalValue).toBe(99 * 1000 + 4960);
  });

  it("charges the spread through the same cost function as the app", () => {
    const fees: FeeConfig = { ...FEES, spreadPct: 0.0005 };
    const r = simulateLongterm({ ...START, fees, bars: [bar("2019-11-01", 20)], dividends: [] });
    // exec 20.01: 49 shares = 98049 + 980 = 99029 <= 100000; 50 shares = 100050 does not fit.
    expect(r.shares).toBe(49);
    expect(r.leftoverCash).toBe(971);
    expect(r.feesPaid).toBe(980);
    expect(r.spreadPaid).toBe(98049 - 98000);
    expect(previewCost("buy", 49, { price: 20, currency: "EUR" }, "market", undefined, fees).total).toBe(99029);
  });

  it("with no bar on or after the start day there is nothing to report", () => {
    const r = simulateLongterm({ ...START, bars: [bar("2019-10-01", 10)], dividends: [] });
    expect(r.points).toEqual([]);
    expect(r.shares).toBe(0);
    expect(r.firstBuyDay).toBeNull();
    expect(r.finalValue).toBe(100000);
  });

  it("a start cash too small for one share stays cash", () => {
    const r = simulateLongterm({ ...START, startCash: 500, bars: [bar("2019-11-01", 10)], dividends: [] });
    expect(r.shares).toBe(0);
    expect(r.leftoverCash).toBe(500);
    expect(r.feesPaid).toBe(0);
  });
});
