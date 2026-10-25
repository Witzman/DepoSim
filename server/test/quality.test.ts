import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data/marketdata.js";
import { checkBar, compareToDaily, dailyTolerance, findOrderProblems, findSpikes } from "../src/domain/quality.js";

const T0 = 1_700_000_000;
const bar = (i: number, c: number, extra: Partial<Bar> = {}): Bar => ({ t: T0 + i * 60, o: c, h: c + 0.05, l: c - 0.05, c, v: 10, ...extra });
/** A calm series around 100 with small wiggles. */
const calm = (n: number, level = 100): Bar[] => Array.from({ length: n }, (_, i) => bar(i, level + (i % 2 ? 0.05 : -0.05)));

describe("checkBar", () => {
  it("accepts a sound bar, also a flat one", () => {
    expect(checkBar(bar(0, 100))).toBeNull();
    expect(checkBar({ t: 0, o: 5, h: 5, l: 5, c: 5, v: 0 })).toBeNull();
  });
  it("finds a high under the body, a low over it, a price of zero or less, and non-numbers", () => {
    expect(checkBar({ t: 0, o: 10, h: 9, l: 8, c: 10, v: 1 })).toMatch(/Hoch/);
    expect(checkBar({ t: 0, o: 10, h: 11, l: 10.5, c: 10.6, v: 1 })).toMatch(/Tief/);
    expect(checkBar({ t: 0, o: 0, h: 1, l: 0, c: 1, v: 1 })).toMatch(/über 0/);
    expect(checkBar({ t: 0, o: -1, h: 1, l: -1, c: 1, v: 1 })).toMatch(/über 0/);
    expect(checkBar({ t: 0, o: NaN, h: 1, l: 1, c: 1, v: 1 })).toMatch(/keine Zahl/);
    expect(checkBar({ t: 0, o: 1, h: Infinity, l: 1, c: 1, v: 1 })).toMatch(/keine Zahl/);
    expect(checkBar({ t: 0, o: 1, h: 1, l: 1, c: 1, v: -3 })).toMatch(/Volumen/);
  });
});

describe("findSpikes", () => {
  it("finds a close that jumps to 1/100 and is back the next minute", () => {
    const bars = calm(40);
    bars[20] = bar(20, 1, { h: 100.1, l: 1, o: 100 });
    expect(findSpikes(bars).map((f) => f.t)).toEqual([bars[20].t]);
  });
  it("finds a ten-fold tick and a single bad high", () => {
    const bars = calm(40);
    bars[10] = bar(10, 1000, { o: 100, l: 99.9 });
    bars[30] = { ...bars[30], h: 400 };
    expect(findSpikes(bars).map((f) => f.t)).toEqual([bars[10].t, bars[30].t]);
  });
  it("does not flag a real jump that stays on the new level (earnings gap)", () => {
    const bars = [...calm(30, 100), ...calm(30, 112)];
    expect(findSpikes(bars)).toEqual([]);
  });
  it("does not flag a swing under 5 % even in a dead-calm series", () => {
    const bars = calm(40);
    bars[20] = bar(20, 103);
    expect(findSpikes(bars)).toEqual([]);
  });
  it("scales the threshold with the noise: a wild series needs a bigger spike", () => {
    // a triangle wave with steps of 3 %: sigma is about 3 %, so 10 sigma is 30 %
    const tri = [0, 3, 6, 9, 6, 3, 0, -3, -6, -9, -6, -3];
    const wild = Array.from({ length: 60 }, (_, i) => bar(i, 100 * (1 + tri[i % 12] / 100)));
    wild[40] = bar(40, wild[39].c * 1.12, { o: wild[39].c });
    expect(findSpikes(wild)).toEqual([]);
  });
  it("needs a next minute: the last bar and a bar before a long hole are not judged", () => {
    const bars = calm(30);
    bars[29] = bar(29, 1, { o: 100, h: 100 });
    expect(findSpikes(bars)).toEqual([]);
    const sparse = calm(30);
    sparse[20] = bar(20, 1, { o: 100, h: 100 });
    for (let i = 21; i < 30; i++) sparse[i] = { ...sparse[i], t: sparse[i].t + 3600 };
    expect(findSpikes(sparse)).toEqual([]);
  });
  it("does not flag a crash day that keeps falling", () => {
    const bars = calm(20).concat(Array.from({ length: 20 }, (_, i) => bar(20 + i, 100 * 0.93 ** (i + 1))));
    expect(findSpikes(bars)).toEqual([]);
  });
});

describe("findOrderProblems", () => {
  it("finds a duplicate and a step back in time", () => {
    const bars = [bar(0, 1), bar(1, 1), bar(1, 1), bar(3, 1), bar(2, 1)];
    expect(findOrderProblems(bars).map((f) => [f.kind, f.t])).toEqual([["dup", bars[2].t], ["time", bars[4].t]]);
  });
  it("is silent for a clean series", () => expect(findOrderProblems(calm(10))).toEqual([]));
});

describe("compareToDaily", () => {
  it("flags a last minute over the tolerance from the daily close", () => {
    const bars = [bar(0, 100), bar(1, 101)];
    expect(compareToDaily(bars, 100, 0.005)?.kind).toBe("daily");
    expect(compareToDaily(bars, 100.8, 0.005)).toBeNull();
    expect(compareToDaily([], 100, 0.005)).toBeNull();
  });
  it("has 0,5 % for Xetra ETFs and 1 % for the rest", () => {
    expect(dailyTolerance("XETRA", "ETF")).toBe(0.005);
    expect(dailyTolerance("US", "EQUITY")).toBe(0.01);
    expect(dailyTolerance("XETRA", "EQUITY")).toBe(0.01);
  });
});
