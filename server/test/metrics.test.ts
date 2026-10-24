import { describe, expect, it } from "vitest";
import { computeMetrics, correlationMatrix, resample, returnsOf, thin } from "../src/domain/metrics.js";

const DAY = 86400;
const T0 = 1792627200 + 12 * 3600; // 2026-10-22 12:00 UTC
const daily = (values: number[]) => values.map((value, i) => ({ t: T0 + i * DAY, value }));
const grow = (n: number, f: number, start = 1_000_000) => {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * f);
  return out;
};
/** A repeatable wobble: no random numbers in a test. */
const wobble = (n: number, amp: number, phase = 0) =>
  Array.from({ length: n }, (_, i) => 1_000_000 * (1 + amp * Math.sin(i * 1.3 + phase) + 0.002 * i));

describe("resample", () => {
  it("keeps the last value of each Berlin day", () => {
    const pts = [
      { t: T0, value: 1 }, { t: T0 + 3600, value: 2 }, // same day
      { t: T0 + DAY, value: 3 },
    ];
    expect(resample(pts, "day").map((p) => p.value)).toEqual([2, 3]);
  });

  it("keeps the last value of each hour and of each five minutes", () => {
    const pts = [0, 60, 120, 3600, 3660].map((s, i) => ({ t: T0 + s, value: i + 1 }));
    expect(resample(pts, "hour").map((p) => p.value)).toEqual([3, 5]);
    expect(resample(pts, "5min").map((p) => p.value)).toEqual([3, 5]);
  });
});

describe("returnsOf", () => {
  it("gives simple returns and skips a step from zero", () => {
    expect(returnsOf([{ t: 1, value: 100 }, { t: 2, value: 110 }, { t: 3, value: 99 }]).map((r) => +r.toFixed(6))).toEqual([0.1, -0.1]);
    expect(returnsOf([{ t: 1, value: 0 }, { t: 2, value: 5 }])).toEqual([]);
  });
});

describe("computeMetrics", () => {
  it("measures a steady climb: return, no volatility, so no Sharpe ratio", () => {
    const m = computeMetrics(daily(grow(12, 1.01)));
    expect(m.basis).toBe("day");
    expect(m.totalReturn).toBeCloseTo(1.01 ** 11 - 1, 9);
    expect(m.volatility).toBeCloseTo(0, 9);
    expect(m.sharpe).toBeNull();
    expect(m.maxDrawdown).toBe(0);
    expect(m.unavailable).toBeUndefined();
  });

  it("annualizes the volatility of a series from its daily returns", () => {
    const values = wobble(30, 0.01);
    const m = computeMetrics(daily(values));
    const r = returnsOf(daily(values));
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
    expect(m.volatility).toBeCloseTo(sd * Math.sqrt(252), 9);
    expect(m.sharpe).toBeCloseTo((mean * 252) / (sd * Math.sqrt(252)), 9);
  });

  it("finds the deepest fall from a peak", () => {
    const m = computeMetrics(daily([100, 120, 90, 130]));
    expect(m.maxDrawdown).toBeCloseTo(-0.25, 9);
    expect(m.totalReturn).toBeCloseTo(0.3, 9);
  });

  it("falls back to hours and to five minutes when there are too few days", () => {
    const hours = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * 3600, value: 1000 + (i % 3) * 10 }));
    // 30 hours cover 2 Berlin days: too few returns by day, enough by hour.
    expect(computeMetrics(hours).basis).toBe("hour");
    const minutes = Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * 300, value: 1000 + (i % 5) * 3 }));
    expect(computeMetrics(minutes).basis).toBe("5min");
  });

  it("says why it cannot give a volatility, but still gives return and fall from the raw points", () => {
    const m = computeMetrics([{ t: T0, value: 100 }, { t: T0 + 60, value: 95 }, { t: T0 + 120, value: 99 }]);
    expect(m.unavailable).toMatch(/zu wenige Werte/);
    expect(m.volatility).toBeNull();
    expect(m.sharpe).toBeNull();
    expect(m.totalReturn).toBeCloseTo(-0.01, 9);
    expect(m.maxDrawdown).toBeCloseTo(-0.05, 9);
  });

  it("handles one point and no points", () => {
    expect(computeMetrics([{ t: T0, value: 100 }])).toMatchObject({ totalReturn: null, maxDrawdown: null, volatility: null });
    expect(computeMetrics([])).toMatchObject({ totalReturn: null, maxDrawdown: null, volatility: null });
  });

  it("never lets NaN or Infinity into the JSON", () => {
    const cases = [daily(grow(12, 1.01)), daily([0, 0, 0]), daily(wobble(30, 0.01)), [], daily(Array(20).fill(500))];
    for (const pts of cases) {
      const m = computeMetrics(pts);
      expect(JSON.parse(JSON.stringify(m))).toEqual(JSON.parse(JSON.stringify({ ...m })));
      for (const v of Object.values(m)) if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("correlationMatrix", () => {
  it("is 1 for a curve with itself and with a copy, and negative for the opposite moves", () => {
    const a = daily(wobble(30, 0.01));
    const inverse = a.map((p, i) => ({ t: p.t, value: 2_000_000 - a[i].value }));
    const m = correlationMatrix([{ id: 1, points: a }, { id: 2, points: a }, { id: 3, points: inverse }]);
    expect(m.ids).toEqual([1, 2, 3]);
    expect(m.matrix[0][0]).toBe(1);
    expect(m.matrix[0][1]).toBeCloseTo(1, 9);
    expect(m.matrix[0][2]!).toBeLessThan(-0.99);
    expect(m.matrix[2][0]).toBe(m.matrix[0][2]);
    expect(m.basis).toBe("day");
  });

  it("is null where the curves share too few moments, or one of them is flat", () => {
    const a = daily(wobble(30, 0.01));
    const shortOne = daily(wobble(5, 0.01));
    const flat = daily(Array(30).fill(1_000_000));
    const m = correlationMatrix([{ id: 1, points: a }, { id: 2, points: shortOne }, { id: 3, points: flat }]);
    expect(m.matrix[0][1]).toBeNull();
    expect(m.matrix[0][2]).toBeNull();
    expect(m.matrix[1][1]).toBe(1);
  });

  it("has no basis when no pair can be measured", () => {
    const m = correlationMatrix([{ id: 1, points: daily([1, 2]) }, { id: 2, points: daily([2, 1]) }]);
    expect(m.basis).toBeNull();
    expect(m.matrix).toEqual([[1, null], [null, 1]]);
  });
});

describe("thin", () => {
  it("keeps short series as they are, and thins long ones to the limit with first and last point", () => {
    const pts = Array.from({ length: 12_000 }, (_, i) => ({ t: i, value: i }));
    expect(thin(pts.slice(0, 50), 5000)).toHaveLength(50);
    const out = thin(pts, 5000);
    expect(out.length).toBeLessThanOrEqual(5000);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    expect(out.every((p, i) => i === 0 || p.t > out[i - 1].t)).toBe(true);
  });
});
