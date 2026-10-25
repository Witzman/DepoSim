import { type Point, PERIODS, bucketed, mean, pearson, resample, stdev } from "./metrics.js";

/** The windows on offer, in trading days. The small ones are for a short history. */
export const WINDOWS = [10, 30, 90, 250] as const;
/** Beta and correlation to the benchmark look at this many days. */
export const BETA_WINDOW = 60;
/** The day horizons of the "share in plus" table, and the fewest windows a share is told from. */
export const HORIZONS = [20, 60, 250] as const;
export const MIN_RANGE_WINDOWS = 30;
/** A volatility below this is a flat line: a Sharpe ratio from it would divide by noise. */
const FLAT = 1e-12;
const DAY_S = 86400;
const SERIES_POINTS = 400;

export interface RollPoint {
  t: number;
  /** Annualized, null when the window is flat or has fewer than two returns. */
  vol: number | null;
  sharpe: number | null;
  /** The change over the window, as a ratio. */
  ret: number;
}

export interface Rolling {
  window: number;
  /** Empty when the history is shorter than the window: no number is made up. */
  points: RollPoint[];
}

/**
 * Rolling volatility, Sharpe ratio and return over a window of `days` trading days, on the daily curve.
 * The first point sits at the end of the first full window. Pure.
 */
export function rollingMetrics(points: Point[], days: number): Rolling {
  const daily = resample(points, "day");
  const out: RollPoint[] = [];
  if (days < 2 || daily.length < days + 1) return { window: days, points: out };
  const r: number[] = [];
  for (let i = 1; i < daily.length; i++) r.push(daily[i - 1].value !== 0 ? daily[i].value / daily[i - 1].value - 1 : 0);
  for (let i = days; i < daily.length; i++) {
    const w = r.slice(i - days, i);
    const vol = stdev(w) * Math.sqrt(PERIODS.day);
    const finite = Number.isFinite(vol) && vol > FLAT;
    const first = daily[i - days].value;
    out.push({
      t: daily[i].t, vol: Number.isFinite(vol) ? vol : null,
      sharpe: finite ? (mean(w) * PERIODS.day) / vol : null,
      ret: first !== 0 ? daily[i].value / first - 1 : 0,
    });
  }
  return { window: days, points: out };
}

export interface BetaPoint {
  t: number;
  beta: number | null;
  corr: number | null;
}

/** Beta and correlation of the depot's daily steps to the benchmark's over the last `BETA_WINDOW` common days. Pure. */
export function rollingBeta(depot: Point[], bench: Point[], window = BETA_WINDOW): BetaPoint[] {
  const b = new Map(bucketed(bench, "day").map((p) => [p.key, p.value]));
  const both = bucketed(depot, "day").filter((p) => b.has(p.key));
  const x: number[] = [];
  const y: number[] = [];
  const ts: number[] = [];
  for (let i = 1; i < both.length; i++) {
    const a0 = both[i - 1].value;
    const b0 = b.get(both[i - 1].key)!;
    if (a0 === 0 || b0 === 0) continue;
    x.push(both[i].value / a0 - 1);
    y.push(b.get(both[i].key)! / b0 - 1);
    ts.push(both[i].t);
  }
  const out: BetaPoint[] = [];
  for (let i = window; i <= x.length; i++) {
    const xs = x.slice(i - window, i);
    const ys = y.slice(i - window, i);
    const vy = stdev(ys) ** 2;
    const cov = xs.reduce((a, v, k) => a + (v - mean(xs)) * (ys[k] - mean(ys)), 0) / (window - 1);
    out.push({ t: ts[i - 1], beta: vy > FLAT ? cov / vy : null, corr: pearson(xs, ys) });
  }
  return out;
}

export interface MonthReturn {
  /** "YYYY-MM" of the Berlin day the daily curve uses. */
  month: string;
  ret: number;
}

export interface YearReturn {
  year: string;
  /** The months of the year compounded. */
  ret: number;
  months: MonthReturn[];
}

/**
 * The change in each calendar month, from the last value of the month before (the first month from the first point).
 * The months compound to the total return exactly. The month is the Berlin day of the daily curve. Pure.
 */
export function monthlyReturns(points: Point[]): MonthReturn[] {
  if (points.length < 2 || points[0].value === 0) return [];
  const daily = bucketed(points, "day");
  const lastOf = new Map<string, number>();
  const order: string[] = [];
  for (const p of daily) {
    const month = String(p.key).slice(0, 7);
    if (!lastOf.has(month)) order.push(month);
    lastOf.set(month, p.value);
  }
  const out: MonthReturn[] = [];
  let prev = points[0].value;
  for (const month of order) {
    const v = lastOf.get(month)!;
    out.push({ month, ret: v / prev - 1 });
    prev = v;
  }
  return out;
}

export function byYear(months: MonthReturn[]): YearReturn[] {
  const years = new Map<string, MonthReturn[]>();
  for (const m of months) years.set(m.month.slice(0, 4), [...(years.get(m.month.slice(0, 4)) ?? []), m]);
  return [...years].map(([year, ms]) => ({ year, ret: ms.reduce((a, m) => a * (1 + m.ret), 1) - 1, months: ms }));
}

export interface Episode {
  /** The peak the fall began from, the lowest point, and the first point back at the peak (null: not recovered yet). */
  peakT: number;
  troughT: number;
  endT: number | null;
  /** As a negative ratio. */
  depth: number;
  /** Calendar days from the peak to the recovery, or to the last point while it goes on. */
  days: number;
  ongoing: boolean;
}

/** The deepest falls from a peak to the next peak, deepest first, on the daily curve. Pure. */
export function drawdownEpisodes(points: Point[], top = 5): Episode[] {
  const daily = resample(points, "day");
  const all: Episode[] = [];
  let peak = daily[0];
  let trough: Point | null = null;
  for (let i = 1; i < daily.length; i++) {
    const p = daily[i];
    if (p.value >= peak.value) {
      if (trough && trough.value < peak.value) {
        all.push({ peakT: peak.t, troughT: trough.t, endT: p.t, depth: trough.value / peak.value - 1, days: Math.round((p.t - peak.t) / DAY_S), ongoing: false });
      }
      peak = p;
      trough = null;
    } else if (peak.value > 0 && (!trough || p.value < trough.value)) {
      trough = p;
    }
  }
  if (trough && trough.value < peak.value && peak.value > 0) {
    const last = daily[daily.length - 1];
    all.push({ peakT: peak.t, troughT: trough.t, endT: null, depth: trough.value / peak.value - 1, days: Math.round((last.t - peak.t) / DAY_S), ongoing: true });
  }
  return all.sort((a, b) => a.depth - b.depth).slice(0, top);
}

export interface RangeStat {
  days: number;
  /** Windows of that length in the history. */
  windows: number;
  /** Share of windows that ended in plus (a change above zero); null with fewer than `MIN_RANGE_WINDOWS` windows. */
  positiveShare: number | null;
}

/** How often a stretch of `days` trading days ended in plus, over every window the history holds. Pure. */
export function rangeStats(points: Point[]): RangeStat[] {
  const daily = resample(points, "day");
  return HORIZONS.map((days) => {
    const windows = Math.max(daily.length - days, 0);
    let plus = 0;
    for (let i = days; i < daily.length; i++) if (daily[i - days].value > 0 && daily[i].value > daily[i - days].value) plus++;
    return { days, windows, positiveShare: windows >= MIN_RANGE_WINDOWS ? plus / windows : null };
  });
}

export interface Analysis {
  rolling: Rolling[];
  months: MonthReturn[];
  years: YearReturn[];
  episodes: Episode[];
  ranges: RangeStat[];
  /** Trading days of history the figures are made from. */
  days: number;
}

/** Everything of this chapter for one curve; the rolling series are thinned to a size a page can draw. */
export function analyze(points: Point[]): Analysis {
  const months = monthlyReturns(points);
  return {
    rolling: WINDOWS.map((w) => ({ window: w, points: thinRoll(rollingMetrics(points, w).points) })),
    months, years: byYear(months), episodes: drawdownEpisodes(points), ranges: rangeStats(points),
    days: resample(points, "day").length,
  };
}

function thinRoll(points: RollPoint[]): RollPoint[] {
  if (points.length <= SERIES_POINTS) return points;
  const step = Math.ceil((points.length - 1) / (SERIES_POINTS - 1));
  const out: RollPoint[] = [];
  for (let i = points.length - 1; i > 0; i -= step) out.push(points[i]);
  out.push(points[0]);
  return out.reverse();
}
