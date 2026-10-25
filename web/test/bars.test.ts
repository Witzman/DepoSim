import { describe, expect, it } from "vitest";
import { aggregate, barChange, heikinAshi, parseChartPrefs, defaultChartPrefs } from "../src/bars.js";
import type { Bar } from "../src/types.js";

const bar = (t: number, o: number, h: number, l: number, c: number, v = 10): Bar => ({ t, o, h, l, c, v });
const T0 = Date.UTC(2026, 9, 23, 8, 0) / 1000; // 10:00 Berlin, on a 5, 15 and 60 minute boundary

describe("aggregate", () => {
  const minute = Array.from({ length: 10 }, (_, i) => bar(T0 + i * 60, 10 + i, 12 + i, 8 + i, 11 + i, 1));
  it("returns the bars as they are for one minute", () => {
    expect(aggregate(minute, "1m")).toBe(minute);
  });
  it("builds open, high, low, close and volume per candle", () => {
    const five = aggregate(minute, "5m");
    expect(five).toHaveLength(2);
    expect(five[0]).toEqual({ t: T0, o: 10, h: 16, l: 8, c: 15, v: 5 });
    expect(five[1]).toEqual({ t: T0 + 300, o: 15, h: 21, l: 13, c: 20, v: 5 });
  });
  it("keeps the outlier mark (#50) when a candle holds a marked minute, and not otherwise", () => {
    const marked = minute.map((b, i) => (i === 7 ? { ...b, flagged: true } : b));
    const five = aggregate(marked, "5m");
    expect(five[0].flagged).toBeUndefined();
    expect(five[1].flagged).toBe(true);
    expect(heikinAshi([marked[7]])[0].flagged).toBe(true);
  });
  it("does not change its input", () => {
    const before = JSON.stringify(minute);
    aggregate(minute, "15m");
    expect(JSON.stringify(minute)).toBe(before);
  });
  it("splits days at midnight in Berlin", () => {
    const two = [bar(T0, 1, 1, 1, 1), bar(T0 + 60, 2, 2, 2, 2), bar(T0 + 86400, 3, 3, 3, 3)];
    const days = aggregate(two, "1d");
    expect(days.map((d) => d.c)).toEqual([2, 3]);
  });
  it("keeps the stamp of a candle that is still forming", () => {
    const grown = aggregate([...minute, bar(T0 + 600, 20, 25, 19, 24, 1)], "5m");
    expect(grown.map((c) => c.t)).toEqual([T0, T0 + 300, T0 + 600]);
  });
  it("is empty for no bars", () => {
    expect(aggregate([], "1h")).toEqual([]);
  });
});

describe("heikinAshi", () => {
  it("averages the close and starts the open at the first bar's body middle", () => {
    const [a, b] = heikinAshi([bar(1, 10, 14, 8, 12), bar(2, 12, 16, 11, 15)]);
    expect(a).toMatchObject({ o: 11, c: 11, h: 14, l: 8 });
    expect(b.c).toBe((12 + 16 + 11 + 15) / 4);
    expect(b.o).toBe((a.o + a.c) / 2);
    expect(b.h).toBeGreaterThanOrEqual(Math.max(b.o, b.c));
    expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
  });
});

describe("chart prefs", () => {
  it("falls back to the defaults", () => {
    expect(parseChartPrefs(null)).toEqual(defaultChartPrefs());
    expect(parseChartPrefs("{x")).toEqual(defaultChartPrefs());
    expect(parseChartPrefs('{"timeframe":"3y","type":7}')).toEqual(defaultChartPrefs());
  });
  it("keeps valid choices", () => {
    expect(parseChartPrefs('{"timeframe":"1h","type":"heikin","scale":"log"}')).toEqual({ timeframe: "1h", type: "heikin", scale: "log" });
  });
});

describe("barChange", () => {
  it("is the move against the bar before", () => {
    const bars = [bar(1, 0, 0, 0, 100), bar(2, 0, 0, 0, 110)];
    expect(barChange(bars, 1)).toEqual({ abs: 10, ratio: 0.1 });
    expect(barChange(bars, 0)).toBeNull();
  });
});

describe("berlinDay", () => {
  it("is the date the formatter gives, also around the change of clocks and midnight", async () => {
    const { berlinDay } = await import("../src/bars.js");
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });
    for (const from of ["2026-03-28T20:00:00Z", "2026-10-24T20:00:00Z", "2026-12-31T20:00:00Z"]) {
      const t0 = Date.parse(from) / 1000;
      for (let i = 0; i < 36 * 6; i++) expect(berlinDay(t0 + i * 600)).toBe(fmt.format((t0 + i * 600) * 1000));
    }
  });
});
