import type { CurvePoint } from "./types.js";

/** Trading days per year and per month, the same day basis as the rolling figures. */
export const DAYS_PER_YEAR = 252;
export const DAYS_PER_MONTH = 21;
/** Fewer daily returns than this and no number is made up. */
export const MIN_HISTORY_DAYS = 60;
export const DEFAULT_PATHS = 5000;
export const DEFAULT_BLOCK = 5;
export const DEFAULT_SEED = 42;
export const HORIZON_YEARS = [1, 3, 5, 10] as const;
/** The fan is drawn at this many points at most; the paths are not kept whole. */
const CHECKPOINTS = 120;
/** The end value percentiles of the table. */
export const END_PERCENTILES = [5, 10, 25, 50, 75, 90, 95] as const;

export type Method = "bootstrap" | "normal";

export interface McInput {
  /** Daily simple returns as ratios (0.01 is +1 %). */
  returns: number[];
  startValue: number;
  years: number;
  paths?: number;
  block?: number;
  seed?: number;
  method?: Method;
  /** Added every month (in the unit of `startValue`). */
  monthlySave?: number;
  /** Taken out every month; a path that is used up stays at zero. */
  monthlyDraw?: number;
  /** A target end value; null or absent when none. */
  goal?: number | null;
}

export interface McBand {
  /** Day index of each point, from 0. */
  days: number[];
  p5: number[]; p10: number[]; p50: number[]; p90: number[]; p95: number[];
}

export interface McResult {
  ok: true;
  seed: number;
  paths: number;
  horizonDays: number;
  historyDays: number;
  method: Method;
  /** Money put in net: start value plus savings minus withdrawals. The loss shares are measured against it. */
  reference: number;
  band: McBand;
  end: { p: number; value: number }[];
  probLoss: number;
  probLoss20: number;
  /** null when no goal was given. */
  probGoal: number | null;
  /** Mean of the end values. */
  mean: number;
}

export interface McRefused {
  ok: false;
  reason: string;
  historyDays: number;
}

/** A small seeded generator: the same seed gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Daily returns of a curve: the last value of each UTC day, and the step from one day to the next. */
export function dailyReturns(points: CurvePoint[]): number[] {
  const byDay = new Map<number, number>();
  for (const p of [...points].sort((a, b) => a.t - b.t)) byDay.set(Math.floor(p.t / 86400), p.value);
  const values = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) out.push(values[i - 1] > 0 ? values[i] / values[i - 1] - 1 : 0);
  return out;
}

/** The p-th percentile (0..100) of a sorted array, linear between ranks. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = (Math.min(Math.max(p, 0), 100) / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/**
 * Simulated paths of the depot: a block bootstrap of its own daily returns (blocks keep a little of the
 * clustering of calm and wild days), or normally distributed returns with the mean and spread of the series.
 * Pure and seeded; refuses a history under `MIN_HISTORY_DAYS`.
 */
export function simulate(input: McInput): McResult | McRefused {
  const { returns, startValue, years } = input;
  const paths = input.paths ?? DEFAULT_PATHS;
  const seed = input.seed ?? DEFAULT_SEED;
  const method = input.method ?? "bootstrap";
  const save = input.monthlySave ?? 0;
  const draw = input.monthlyDraw ?? 0;
  if (returns.length < MIN_HISTORY_DAYS) {
    return { ok: false, historyDays: returns.length, reason: `Zu wenig Historie: ${returns.length} von mindestens ${MIN_HISTORY_DAYS} Handelstagen. Mit so wenigen Tagen wäre jede Spanne Zufall.` };
  }
  if (!(startValue > 0)) return { ok: false, historyDays: returns.length, reason: "Das Depot ist leer: ohne Wert gibt es nichts fortzuschreiben." };

  const horizon = Math.max(1, Math.round(years * DAYS_PER_YEAR));
  const block = Math.max(1, Math.min(input.block ?? DEFAULT_BLOCK, returns.length));
  const rand = mulberry32(seed);
  const mu = mean(returns);
  const sigma = stdev(returns);

  const step = Math.max(1, Math.ceil(horizon / CHECKPOINTS));
  const cpDays: number[] = [];
  for (let d = step; d < horizon; d += step) cpDays.push(d);
  cpDays.push(horizon);
  const cp = new Float64Array(cpDays.length * paths);
  const ends = new Float64Array(paths);

  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };

  const net = save - draw;
  for (let p = 0; p < paths; p++) {
    let value = startValue;
    let ci = 0;
    let day = 0;
    while (day < horizon) {
      let start = 0;
      if (method === "bootstrap") start = Math.floor(rand() * (returns.length - block + 1));
      for (let k = 0; k < block && day < horizon; k++) {
        const r = method === "bootstrap" ? returns[start + k] : mu + sigma * gauss();
        value *= 1 + r;
        if (value < 0) value = 0;
        day++;
        if (day % DAYS_PER_MONTH === 0 && net !== 0) value = Math.max(0, value + net);
        if (day === cpDays[ci]) { cp[ci * paths + p] = value; ci++; }
      }
    }
    ends[p] = value;
  }

  const band: McBand = { days: [0, ...cpDays], p5: [startValue], p10: [startValue], p50: [startValue], p90: [startValue], p95: [startValue] };
  for (let i = 0; i < cpDays.length; i++) {
    const col = cp.subarray(i * paths, (i + 1) * paths);
    col.sort();
    band.p5.push(percentile(col, 5)); band.p10.push(percentile(col, 10)); band.p50.push(percentile(col, 50));
    band.p90.push(percentile(col, 90)); band.p95.push(percentile(col, 95));
  }

  const sortedEnds = Float64Array.from(ends).sort();
  const months = Math.floor(horizon / DAYS_PER_MONTH);
  const reference = Math.max(0, startValue + net * months);
  let loss = 0;
  let loss20 = 0;
  let goalHit = 0;
  const goal = input.goal ?? null;
  for (let p = 0; p < paths; p++) {
    if (ends[p] < reference) loss++;
    if (ends[p] < reference * 0.8) loss20++;
    if (goal !== null && ends[p] >= goal) goalHit++;
  }
  return {
    ok: true, seed, paths, horizonDays: horizon, historyDays: returns.length, method, reference, band,
    end: END_PERCENTILES.map((p) => ({ p, value: percentile(sortedEnds, p) })),
    probLoss: loss / paths, probLoss20: loss20 / paths, probGoal: goal === null ? null : goalHit / paths,
    mean: mean(Array.from(ends)),
  };
}
