import { describe, expect, it } from "vitest";
import { bollinger, compute, ema, macd, rsi, sma } from "../src/indicators.js";

const noNaN = (xs: (number | null)[]) => xs.every((x) => x === null || Number.isFinite(x));

describe("sma", () => {
  it("averages the last period values", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("is all null when the series is shorter than the period", () => {
    expect(sma([1, 2], 3)).toEqual([null, null]);
  });
});

describe("ema", () => {
  it("is seeded with the sma of the first period values", () => {
    // k = 2/(3+1) = 0.5: seed 2, then 2 + .5*(4-2) = 3, then 3 + .5*(5-3) = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("weights the newest value by 2/(n+1)", () => {
    // seed (1+2)/2 = 1.5, k = 2/3: 1.5 + 2/3*(6-1.5) = 4.5
    const r = ema([1, 2, 6], 2);
    expect(r[1]).toBe(1.5);
    expect(r[2]).toBeCloseTo(4.5, 10);
  });
  it("is all null when too short", () => {
    expect(ema([1], 3)).toEqual([null]);
  });
});

describe("rsi", () => {
  it("is 100 for a strictly rising series", () => {
    const r = rsi([1, 2, 3, 4, 5, 6], 3);
    expect(r.slice(0, 3)).toEqual([null, null, null]);
    expect(r.slice(3)).toEqual([100, 100, 100]);
  });
  it("is 0 for a strictly falling series", () => {
    expect(rsi([6, 5, 4, 3, 2], 3)[3]).toBe(0);
  });
  it("is 50 for a flat series (no gains, no losses)", () => {
    expect(rsi([5, 5, 5, 5, 5], 3).slice(3)).toEqual([50, 50]);
  });
  it("uses Wilder smoothing", () => {
    // changes +1 +1 -1: avgGain 2/3, avgLoss 1/3 -> rs 2 -> 66.666...
    const r = rsi([1, 2, 3, 2], 3);
    expect(r[3]).toBeCloseTo(100 - 100 / 3, 10);
    // next change +1: avgGain (2/3*2+1)/3 = 7/9, avgLoss (1/3*2)/3 = 2/9 -> rs 3.5
    expect(rsi([1, 2, 3, 2, 3], 3)[4]).toBeCloseTo(100 - 100 / 4.5, 10);
  });
  it("is all null when too short", () => {
    expect(rsi([1, 2, 3], 3)).toEqual([null, null, null]);
  });
});

describe("macd", () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);
  it("has the hist as macd minus signal and the input's length", () => {
    const r = macd(values);
    expect(r.macd).toHaveLength(60);
    expect(r.macd[24]).toBeNull();
    expect(r.macd[25]).not.toBeNull();
    expect(r.signal[32]).toBeNull();
    expect(r.signal[33]).not.toBeNull(); // 25 + 9 - 1
    for (let i = 0; i < 60; i++) {
      if (r.hist[i] === null) continue;
      expect(r.hist[i]).toBeCloseTo(r.macd[i]! - r.signal[i]!, 10);
    }
    expect(noNaN([...r.macd, ...r.signal, ...r.hist])).toBe(true);
  });
  it("is zero for a constant series", () => {
    const r = macd(Array(40).fill(7));
    expect(r.macd[39]).toBe(0);
    expect(r.hist[39]).toBe(0);
  });
  it("is all null when too short", () => {
    const r = macd([1, 2, 3]);
    expect([...r.macd, ...r.signal, ...r.hist].every((x) => x === null)).toBe(true);
  });
});

describe("bollinger", () => {
  it("uses the population standard deviation", () => {
    // [1,2,3]: mean 2, variance 2/3
    const r = bollinger([1, 2, 3], 3, 2);
    const sd = Math.sqrt(2 / 3);
    expect(r.mid[2]).toBe(2);
    expect(r.upper[2]).toBeCloseTo(2 + 2 * sd, 10);
    expect(r.lower[2]).toBeCloseTo(2 - 2 * sd, 10);
    expect(r.mid[1]).toBeNull();
  });
  it("has width 0 for a constant series", () => {
    const r = bollinger([4, 4, 4, 4], 3, 2);
    expect(r.upper[3]).toBe(4);
    expect(r.lower[3]).toBe(4);
  });
  it("is all null when too short", () => {
    expect(bollinger([1, 2], 20).upper).toEqual([null, null]);
  });
});

describe("compute", () => {
  const closes = Array.from({ length: 50 }, (_, i) => 10 + (i % 7));
  it("computes only the enabled indicators", () => {
    const r = compute(closes, { sma: { period: 5 }, rsi: { period: 14 } });
    expect(Object.keys(r).sort()).toEqual(["rsi", "sma"]);
    expect(r.sma).toHaveLength(50);
    expect(noNaN(r.rsi!)).toBe(true);
  });
  it("returns an empty result when nothing is enabled", () => {
    expect(compute(closes, {})).toEqual({});
  });
});
