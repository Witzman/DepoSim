import { describe, expect, it } from "vitest";
import { dailyReturns, MIN_HISTORY_DAYS, mulberry32, percentile, simulate } from "../src/monteCarlo.js";

const series = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

describe("mulberry32", () => {
  it("gives the same sequence for the same seed and another for another", () => {
    const a = mulberry32(7); const b = mulberry32(7); const c = mulberry32(8);
    const xs = series(5, () => a()); const ys = series(5, () => b()); const zs = series(5, () => c());
    expect(xs).toEqual(ys);
    expect(xs).not.toEqual(zs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe("percentile", () => {
  it("is linear between ranks", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([0, 10], 25)).toBe(2.5);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
  });
});

describe("dailyReturns", () => {
  it("takes the last value of each day and the step between days", () => {
    const pts = [
      { t: 0, value: 100 }, { t: 3600, value: 101 },
      { t: 86400 + 10, value: 111.1 }, { t: 86400 * 2, value: 111.1 },
    ];
    const r = dailyReturns(pts);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 5);
    expect(r[1]).toBeCloseTo(0, 10);
  });
});

describe("simulate", () => {
  const noisy = series(300, (i) => Math.sin(i * 1.7) * 0.01 + 0.0004);

  it("refuses a history under the minimum and says why", () => {
    const r = simulate({ returns: series(MIN_HISTORY_DAYS - 1, () => 0.001), startValue: 1000, years: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Zu wenig Historie/);
  });

  it("refuses an empty depot", () => {
    expect(simulate({ returns: noisy, startValue: 0, years: 1 }).ok).toBe(false);
  });

  it("is reproducible: the same seed gives the same percentiles", () => {
    const a = simulate({ returns: noisy, startValue: 10000, years: 3, paths: 800, seed: 5 });
    const b = simulate({ returns: noisy, startValue: 10000, years: 3, paths: 800, seed: 5 });
    const c = simulate({ returns: noisy, startValue: 10000, years: 3, paths: 800, seed: 6 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("a constant return without spread gives one path: all percentiles coincide", () => {
    const r = simulate({ returns: series(100, () => 0.001), startValue: 1000, years: 1, paths: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = 1000 * 1.001 ** 252;
    for (const e of r.end) expect(e.value).toBeCloseTo(expected, 6);
    expect(r.band.p5.at(-1)).toBeCloseTo(r.band.p95.at(-1)!, 6);
    expect(r.probLoss).toBe(0);
  });

  it("the bootstrap mean of the daily step nears the sample mean", () => {
    const r = simulate({ returns: noisy, startValue: 1000, years: 1, paths: 4000, seed: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = noisy.reduce((a, b) => a + b, 0) / noisy.length;
    const expected = 1000 * (1 + m) ** 252;
    expect(Math.abs(r.mean / expected - 1)).toBeLessThan(0.03);
  });

  it("the band is ordered and widens with time", () => {
    const r = simulate({ returns: noisy, startValue: 1000, years: 5, paths: 1000 });
    if (!r.ok) throw new Error("refused");
    const { band } = r;
    for (let i = 0; i < band.days.length; i++) {
      expect(band.p5[i]).toBeLessThanOrEqual(band.p10[i]);
      expect(band.p10[i]).toBeLessThanOrEqual(band.p50[i]);
      expect(band.p50[i]).toBeLessThanOrEqual(band.p90[i]);
      expect(band.p90[i]).toBeLessThanOrEqual(band.p95[i]);
    }
    const spread = (i: number) => band.p95[i] - band.p5[i];
    expect(spread(band.days.length - 1)).toBeGreaterThan(spread(5));
    expect(band.days.at(-1)).toBe(5 * 252);
  });

  it("a shorter history gives a wider range than a longer one with the same spread", () => {
    const base = series(400, (i) => (i % 2 === 0 ? 0.01 : -0.009));
    const a = simulate({ returns: base.slice(0, 70), startValue: 1000, years: 1, paths: 1000, seed: 1, block: 5 });
    const b = simulate({ returns: base, startValue: 1000, years: 1, paths: 1000, seed: 1, block: 5 });
    expect(a.ok && b.ok).toBe(true);
  });

  it("savings add to the end value, withdrawals take from it and never go below zero", () => {
    const flat = series(100, () => 0);
    const s = simulate({ returns: flat, startValue: 1000, years: 1, paths: 50, monthlySave: 100 });
    const w = simulate({ returns: flat, startValue: 1000, years: 1, paths: 50, monthlyDraw: 500 });
    if (!s.ok || !w.ok) throw new Error("refused");
    expect(s.end.find((e) => e.p === 50)!.value).toBeCloseTo(1000 + 100 * 12, 6);
    expect(s.reference).toBe(2200);
    expect(w.end.find((e) => e.p === 50)!.value).toBe(0);
  });

  it("measures loss against the money put in and a goal against the end value", () => {
    const down = series(100, () => -0.001);
    const r = simulate({ returns: down, startValue: 1000, years: 1, paths: 50, goal: 900 });
    if (!r.ok) throw new Error("refused");
    expect(r.probLoss).toBe(1);
    expect(r.probLoss20).toBe(1); // 0.999^252 is about 0.777: more than 20 % lost
    expect(r.probGoal).toBe(0);
  });

  it("the normal method uses the mean and spread of the series", () => {
    const r = simulate({ returns: noisy, startValue: 1000, years: 1, paths: 3000, method: "normal", seed: 2 });
    if (!r.ok) throw new Error("refused");
    expect(r.method).toBe("normal");
    const m = noisy.reduce((a, b) => a + b, 0) / noisy.length;
    expect(Math.abs(r.mean / (1000 * (1 + m) ** 252) - 1)).toBeLessThan(0.05);
  });

  it("5000 paths over 10 years take under two seconds", () => {
    const t0 = performance.now();
    const r = simulate({ returns: noisy, startValue: 1000, years: 10 });
    const ms = performance.now() - t0;
    console.log(`monte carlo 5000 x 10 years: ${ms.toFixed(0)} ms`);
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
});
