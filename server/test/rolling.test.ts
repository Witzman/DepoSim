import { describe, expect, it } from "vitest";
import { computeMetrics, type Point } from "../src/domain/metrics.js";
import {
  BETA_WINDOW, MIN_RANGE_WINDOWS, analyze, byYear, drawdownEpisodes, monthlyReturns, rangeStats, rollingBeta, rollingMetrics,
} from "../src/domain/rolling.js";

const DAY = 86400;
const T0 = Date.parse("2024-01-02T12:00:00Z") / 1000;
/** One point per day at noon UTC (the same Berlin day), `n` values from `f`. */
const series = (n: number, f: (i: number) => number): Point[] => Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, value: f(i) }));

describe("rollingMetrics", () => {
  it("has volatility 0 and no Sharpe ratio for a constant curve", () => {
    const r = rollingMetrics(series(40, () => 100), 10);
    expect(r.points).toHaveLength(30);
    for (const p of r.points) {
      expect(p.vol).toBe(0);
      expect(p.sharpe).toBeNull();
      expect(p.ret).toBe(0);
    }
  });

  it("matches a hand-worked window: steps +1 % and -1 % in turn", () => {
    // values 100, 101, 99.99, 100.9899, ...: returns +0.01, -0.01, +0.01, -0.01 ...
    const pts = series(11, (i) => (i === 0 ? 100 : 0));
    let v = 100;
    for (let i = 1; i < 11; i++) { v *= i % 2 === 1 ? 1.01 : 0.99; pts[i].value = v; }
    const r = rollingMetrics(pts, 10);
    expect(r.points).toHaveLength(1);
    const returns = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
    const m = 0; // five up, five down
    const sd = Math.sqrt(returns.reduce((a, x) => a + (x - m) ** 2, 0) / 9);
    expect(r.points[0].vol).toBeCloseTo(sd * Math.sqrt(252), 12);
    expect(r.points[0].sharpe).toBeCloseTo((m * 252) / (sd * Math.sqrt(252)), 12);
    expect(r.points[0].ret).toBeCloseTo(v / 100 - 1, 12);
  });

  it("gives no number when the window is longer than the history", () => {
    expect(rollingMetrics(series(30, (i) => 100 + i), 30).points).toEqual([]); // 30 points are 29 steps
    expect(rollingMetrics(series(31, (i) => 100 + i), 30).points).toHaveLength(1);
    expect(rollingMetrics([], 10).points).toEqual([]);
    expect(rollingMetrics(series(5, (i) => 100 + i), 1).points).toEqual([]);
  });

  it("sees the change over the window and uses daily values, not minutes", () => {
    const minutes: Point[] = [];
    for (let d = 0; d < 12; d++) for (let m = 0; m < 3; m++) minutes.push({ t: T0 + d * DAY + m * 60, value: 100 + d + m * 0.1 });
    const r = rollingMetrics(minutes, 5);
    expect(r.points).toHaveLength(7);
    expect(r.points[0].ret).toBeCloseTo(105.2 / 100.2 - 1, 12); // the last value of each day
  });
});

describe("rollingBeta", () => {
  const bench = series(100, (i) => 100 * 1.001 ** i * (1 + 0.01 * Math.sin(i)));

  it("is 1 with correlation 1 for a curve equal to the benchmark, and 2 for twice its moves", () => {
    const same = rollingBeta(bench, bench);
    expect(same).toHaveLength(100 - 1 - BETA_WINDOW + 1);
    expect(same[same.length - 1].beta).toBeCloseTo(1, 9);
    expect(same[same.length - 1].corr).toBeCloseTo(1, 9);
    // twice the daily moves
    const twice: Point[] = [{ t: bench[0].t, value: 100 }];
    for (let i = 1; i < bench.length; i++) twice.push({ t: bench[i].t, value: twice[i - 1].value * (1 + 2 * (bench[i].value / bench[i - 1].value - 1)) });
    expect(rollingBeta(twice, bench).at(-1)!.beta).toBeCloseTo(2, 9);
  });

  it("has nothing with too few common days, and a flat benchmark has no beta", () => {
    expect(rollingBeta(bench.slice(0, 30), bench.slice(0, 30))).toEqual([]);
    const flat = rollingBeta(bench, series(100, () => 100));
    expect(flat.at(-1)).toMatchObject({ beta: null, corr: null });
  });
});

describe("monthlyReturns", () => {
  const curve: Point[] = [
    { t: Date.parse("2024-01-02T12:00:00Z") / 1000, value: 100 },
    { t: Date.parse("2024-01-31T12:00:00Z") / 1000, value: 110 },
    { t: Date.parse("2024-02-15T12:00:00Z") / 1000, value: 99 },
    { t: Date.parse("2024-02-29T12:00:00Z") / 1000, value: 121 },
    { t: Date.parse("2024-03-04T12:00:00Z") / 1000, value: 108.9 },
  ];

  it("measures a month from the last value of the month before, the first from the first point", () => {
    const m = monthlyReturns(curve);
    expect(m.map((x) => x.month)).toEqual(["2024-01", "2024-02", "2024-03"]);
    expect(m[0].ret).toBeCloseTo(0.1, 12);
    expect(m[1].ret).toBeCloseTo(121 / 110 - 1, 12);
    expect(m[2].ret).toBeCloseTo(108.9 / 121 - 1, 12);
  });

  it("compounds to the total return of the metrics, to 1e-9", () => {
    const total = computeMetrics(curve).totalReturn!;
    expect(monthlyReturns(curve).reduce((a, m) => a * (1 + m.ret), 1) - 1).toBeCloseTo(total, 9);
    const long = series(400, (i) => 1000 * 1.0007 ** i * (1 + 0.02 * Math.sin(i / 3)));
    const t2 = computeMetrics(long).totalReturn!;
    expect(Math.abs(monthlyReturns(long).reduce((a, m) => a * (1 + m.ret), 1) - 1 - t2)).toBeLessThan(1e-9);
  });

  it("sums up a year by compounding its months", () => {
    const y = byYear(monthlyReturns(curve));
    expect(y).toHaveLength(1);
    expect(y[0].year).toBe("2024");
    expect(y[0].ret).toBeCloseTo(108.9 / 100 - 1, 12);
  });

  it("is empty for a curve with one point or a zero start", () => {
    expect(monthlyReturns([curve[0]])).toEqual([]);
    expect(monthlyReturns([{ t: 1, value: 0 }, { t: 2, value: 5 }])).toEqual([]);
  });
});

describe("drawdownEpisodes", () => {
  const pts = series(14, (i) => [100, 110, 100, 90, 95, 110, 120, 108, 115, 119, 125, 100, 80, 90][i]);

  it("lists the falls from a peak, deepest first, with the time under water", () => {
    const e = drawdownEpisodes(pts);
    // falls: 110 -> 90 (back at 110 on day 5), 120 -> 108 (back at 120+ on day 10), 125 -> 80 (not back)
    expect(e.map((x) => Math.round(x.depth * 1000) / 1000)).toEqual([-0.36, -0.182, -0.1]);
    const deepest = e[0];
    expect(deepest).toMatchObject({ peakT: pts[10].t, troughT: pts[12].t, endT: null, ongoing: true, days: 3 });
    expect(e[1]).toMatchObject({ peakT: pts[1].t, troughT: pts[3].t, endT: pts[5].t, ongoing: false, days: 4 });
    expect(e[2]).toMatchObject({ peakT: pts[6].t, troughT: pts[7].t, endT: pts[10].t, ongoing: false, days: 4 });
  });

  it("keeps the five deepest and has none for a curve that only rises", () => {
    const zig = series(40, (i) => 100 + (i % 4 === 3 ? -(Math.floor(i / 4) + 1) : i % 4) + Math.floor(i / 4) * 5);
    expect(drawdownEpisodes(zig, 5).length).toBeLessThanOrEqual(5);
    expect(drawdownEpisodes(series(10, (i) => 100 + i))).toEqual([]);
    expect(drawdownEpisodes([])).toEqual([]);
  });
});

describe("rangeStats", () => {
  it("tells the share of windows in plus only with enough windows", () => {
    const up = rangeStats(series(60, (i) => 100 + i));
    expect(up.find((r) => r.days === 20)).toEqual({ days: 20, windows: 40, positiveShare: 1 });
    expect(up.find((r) => r.days === 60)).toEqual({ days: 60, windows: 0, positiveShare: null });
    expect(up.find((r) => r.days === 250)!.positiveShare).toBeNull();
    const short = rangeStats(series(20 + MIN_RANGE_WINDOWS - 1, (i) => 100 + i));
    expect(short.find((r) => r.days === 20)!.positiveShare).toBeNull(); // one window short of enough
  });

  it("counts a flat or falling window as not in plus", () => {
    const down = rangeStats(series(120, (i) => 200 - i));
    expect(down.find((r) => r.days === 20)!.positiveShare).toBe(0);
    const flat = rangeStats(series(120, () => 100));
    expect(flat.find((r) => r.days === 20)!.positiveShare).toBe(0);
  });
});

describe("analyze", () => {
  it("offers every window and leaves out what the history cannot carry", () => {
    const a = analyze(series(50, (i) => 100 + i));
    expect(a.days).toBe(50);
    expect(a.rolling.map((r) => [r.window, r.points.length > 0])).toEqual([[10, true], [30, true], [90, false], [250, false]]);
    expect(a.months.length).toBeGreaterThan(0);
    expect(a.years[0].months).toEqual(a.months.filter((m) => m.month.startsWith(a.years[0].year)));
  });

  it("keeps a long series small for the page", () => {
    const a = analyze(series(2000, (i) => 100 + Math.sin(i / 20) * 10 + i * 0.01));
    expect(a.rolling[0].points.length).toBeLessThanOrEqual(400);
    expect(a.rolling[0].points.at(-1)!.t).toBe(T0 + 1999 * DAY);
  });
});
