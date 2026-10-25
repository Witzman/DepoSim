import { describe, expect, it } from "vitest";
import { findGaps, foldDays, marketEvents } from "../src/domain/marketEvents.js";

const D = (day: string, h = 0) => Date.parse(`${day}T00:00:00Z`) / 1000 + h * 3600;
const bar = (day: string, o: number, c: number, h = 0) => ({ t: D(day, h), o, c });

describe("foldDays", () => {
  it("makes one entry per day with the first open, the last close and the time of the first bar", () => {
    const days = foldDays([bar("2026-03-02", 10, 11, 9), bar("2026-03-02", 11, 12, 10), bar("2026-03-03", 12, 13, 9)]);
    expect(days).toEqual([
      { day: "2026-03-02", t: D("2026-03-02", 9), o: 10, c: 12 },
      { day: "2026-03-03", t: D("2026-03-03", 9), o: 12, c: 13 },
    ]);
  });
});

describe("findGaps", () => {
  it("finds an opening at least three percent away from the close before, up and down", () => {
    const bars = [bar("2026-03-02", 100, 100), bar("2026-03-03", 103, 104), bar("2026-03-04", 104.5, 100), bar("2026-03-05", 100, 99)];
    const gaps = findGaps("SAP.DE", bars);
    expect(gaps.map((g) => [g.day, g.kind])).toEqual([["2026-03-03", "gap"]]);
    expect(findGaps("SAP.DE", [bar("2026-03-02", 100, 100), bar("2026-03-03", 96, 96)])[0].text).toContain("−4,0 %");
    expect(gaps[0].text).toContain("+3,0 %");
    expect(gaps[0].key).toBe("gap:SAP.DE:2026-03-03");
  });

  it("does not take the move inside a day or just under the limit for a gap, and the first day has nothing before it", () => {
    expect(findGaps("X", [bar("2026-03-02", 100, 120), bar("2026-03-03", 120, 90)])).toEqual([]);
    expect(findGaps("X", [bar("2026-03-02", 100, 100), bar("2026-03-03", 102.9, 100)])).toEqual([]);
    expect(findGaps("X", [bar("2026-03-02", 100, 100)])).toEqual([]);
    expect(findGaps("X", [])).toEqual([]);
  });

  it("takes the limit as a parameter", () => {
    expect(findGaps("X", [bar("2026-03-02", 100, 100), bar("2026-03-03", 101.5, 100)], 0.01)).toHaveLength(1);
  });
});

describe("marketEvents", () => {
  const bars = [bar("2026-03-02", 100, 100, 9), bar("2026-03-03", 100, 100, 9), bar("2026-03-04", 100, 100, 9)];

  it("puts dividends and splits on the first bar of their day, oldest first, in the currency of the title", () => {
    const e = marketEvents({
      symbol: "AAPL", currency: "USD", bars,
      dividends: [{ exDay: "2026-03-03", amount: 0.25 }], splits: [{ day: "2026-03-02", numerator: 4, denominator: 1 }],
    });
    expect(e.map((x) => [x.kind, x.day, x.t])).toEqual([["split", "2026-03-02", D("2026-03-02", 9)], ["dividend", "2026-03-03", D("2026-03-03", 9)]]);
    expect(e[1].text).toBe("Ausschüttung AAPL 0,25 $ je Stück (Ex-Tag)");
    expect(e[0].text).toBe("Aktiensplit AAPL 4:1");
  });

  it("shows nothing after the last bar, never ahead of the clock", () => {
    const e = marketEvents({ symbol: "SAP.DE", currency: "EUR", bars, dividends: [{ exDay: "2026-03-05", amount: 2 }], splits: [{ day: "2026-04-01", numerator: 2, denominator: 1 }] });
    expect(e).toEqual([]);
  });

  it("keeps an event of a day without a known bar, without a marker time", () => {
    const e = marketEvents({ symbol: "SAP.DE", currency: "EUR", bars: [bar("2026-03-04", 100, 100)], dividends: [{ exDay: "2026-03-01", amount: 2 }], splits: [] });
    expect(e).toHaveLength(1);
    expect(e[0].t).toBeNull();
  });

  it("is empty without bars", () => {
    expect(marketEvents({ symbol: "X", currency: "EUR", bars: [], dividends: [{ exDay: "2026-03-01", amount: 1 }], splits: [] })).toEqual([]);
  });
});
