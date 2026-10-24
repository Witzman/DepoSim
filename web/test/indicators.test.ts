import { describe, expect, it } from "vitest";
import { atr, bollinger, compute, ema, macd, obv, rsi, sma, stochastic, vwap, type Ohlcv } from "../src/indicators.js";

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

const bar = (t: number, o: number, h: number, l: number, c: number, v = 100): Ohlcv => ({ t, o, h, l, c, v });
// 2026-10-23 10:00 Berlin (08:00 UTC), one bar a minute
const T0 = Date.UTC(2026, 9, 23, 8, 0) / 1000;

describe("atr", () => {
  it("is the mean true range at first, then Wilder-smoothed", () => {
    const bars = [bar(T0, 10, 11, 9, 10), bar(T0 + 60, 10, 12, 10, 11), bar(T0 + 120, 11, 13, 11, 12), bar(T0 + 180, 12, 12, 9, 10)];
    // true ranges: 2, 2, 3  -> seed (2+2)/2 = 2 at index 2 for period 2, then (2*1+3)/2 = 2.5
    const r = atr(bars, 2);
    expect(r.slice(0, 2)).toEqual([null, null]);
    expect(r[2]).toBe(2);
    expect(r[3]).toBe(2.5);
  });
  it("counts a gap in the true range", () => {
    const bars = [bar(T0, 10, 10, 10, 10), bar(T0 + 60, 20, 21, 20, 21)];
    expect(atr(bars, 1)[1]).toBe(11); // |21 - 10|
  });
  it("is all null when too short", () => {
    expect(atr([bar(T0, 1, 1, 1, 1)], 14)).toEqual([null]);
  });
});

describe("stochastic", () => {
  it("is 100 at the top of the range and 0 at the bottom", () => {
    const up = [bar(T0, 1, 2, 1, 2), bar(T0 + 60, 2, 3, 2, 3), bar(T0 + 120, 3, 4, 3, 4)];
    expect(stochastic(up, 3, 1).k[2]).toBe(100);
    const down = [bar(T0, 4, 4, 3, 3), bar(T0 + 60, 3, 3, 2, 2), bar(T0 + 120, 2, 2, 1, 1)];
    expect(stochastic(down, 3, 1).k[2]).toBe(0);
  });
  it("is 50 for a flat range and %D waits for %K", () => {
    const flat = Array.from({ length: 5 }, (_, i) => bar(T0 + i * 60, 5, 5, 5, 5));
    const r = stochastic(flat, 2, 3);
    expect(r.k).toEqual([null, 50, 50, 50, 50]);
    expect(r.d).toEqual([null, null, null, 50, 50]);
  });
});

describe("obv", () => {
  it("adds volume on up closes, subtracts on down closes, keeps on equal", () => {
    const bars = [bar(T0, 1, 1, 1, 10, 5), bar(T0 + 60, 1, 1, 1, 11, 7), bar(T0 + 120, 1, 1, 1, 10, 3), bar(T0 + 180, 1, 1, 1, 10, 9)];
    expect(obv(bars)).toEqual([0, 7, 4, 4]);
  });
});

describe("vwap", () => {
  it("weights the typical price by volume and restarts every day", () => {
    const bars = [
      bar(T0, 0, 12, 8, 10, 1), // typical 10
      bar(T0 + 60, 0, 21, 15, 18, 3), // typical 18
      bar(T0 + 86400, 0, 6, 6, 6, 2), // next day, typical 6
    ];
    const r = vwap(bars);
    expect(r[0]).toBe(10);
    expect(r[1]).toBe((10 * 1 + 18 * 3) / 4);
    expect(r[2]).toBe(6);
  });
  it("stays null while there is no volume", () => {
    expect(vwap([bar(T0, 1, 1, 1, 1, 0)])).toEqual([null]);
  });
});

describe("compute with bars", () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(T0 + i * 60, 10 + i, 11 + i, 9 + i, 10 + i));
  it("leaves the bar-based indicators out without bars", () => {
    expect(compute(bars.map((b) => b.c), { atr: { period: 5 }, obv: {} })).toEqual({});
  });
  it("computes them with bars, all of the input length and never NaN", () => {
    const r = compute(bars.map((b) => b.c), { atr: { period: 5 }, obv: {}, vwap: {}, stoch: { k: 5, d: 3 } }, bars);
    for (const s of [r.atr!, r.obv!, r.vwap!, r.stoch!.k, r.stoch!.d]) {
      expect(s).toHaveLength(30);
      expect(noNaN(s)).toBe(true);
    }
  });
});
