export interface Point {
  t: number;
  value: number;
}

/** The step of the returns a figure is computed from. The coarsest one with enough returns is used. */
export type Basis = "day" | "hour" | "5min";

const LADDER: Basis[] = ["day", "hour", "5min"];
/** Periods per year: 252 trading days, about 8 trading hours a day. An estimate, and shown as one. */
const PERIODS: Record<Basis, number> = { day: 252, hour: 252 * 8, "5min": 252 * 96 };
export const MIN_RETURNS = 10;
/** A volatility below this is a flat line: a Sharpe ratio from it would divide by noise. */
const FLAT = 1e-12;

const berlinDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });
const bucketOf = (t: number, basis: Basis): string | number =>
  basis === "day" ? berlinDate.format(t * 1000) : Math.floor(t / (basis === "hour" ? 3600 : 300));

interface Bucketed extends Point {
  key: string | number;
}

function bucketed(points: Point[], basis: Basis): Bucketed[] {
  const out: Bucketed[] = [];
  for (const p of points) {
    const key = bucketOf(p.t, basis);
    if (out.length > 0 && out[out.length - 1].key === key) out[out.length - 1] = { ...p, key };
    else out.push({ ...p, key });
  }
  return out;
}

/** The last value of each day (Berlin), hour or five minutes. The points must be in time order. */
export const resample = (points: Point[], basis: Basis): Point[] =>
  bucketed(points, basis).map(({ t, value }) => ({ t, value }));

/** At most `max` points, evenly spaced from the end backwards, with the first and the last point kept. */
export function thin(points: Point[], max: number): Point[] {
  if (points.length <= max) return points;
  const step = Math.ceil((points.length - 1) / (max - 1));
  const out: Point[] = [];
  for (let i = points.length - 1; i > 0; i -= step) out.push(points[i]);
  out.push(points[0]);
  return out.reverse();
}

/** Simple returns between neighbours. A step from a value of zero has no return and is left out. */
export function returnsOf(points: Point[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) if (points[i - 1].value !== 0) out.push(points[i].value / points[i - 1].value - 1);
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

export interface Metrics {
  basis: Basis | null;
  periodsPerYear: number | null;
  /** Change from the first to the last point, as a ratio (0.05 is +5 %). */
  totalReturn: number | null;
  /** Annualized, as a ratio. */
  volatility: number | null;
  /** The deepest fall from a peak, as a negative ratio, or 0. */
  maxDrawdown: number | null;
  /** Annualized mean return over volatility, without a risk-free rate. */
  sharpe: number | null;
  /** Annualized mean return over the annualized downside deviation (only falling steps count as risk). */
  sortino: number | null;
  /** Annualized return over the size of the maximum drawdown. */
  calmar: number | null;
  /** The loss that one step in twenty reaches or exceeds (historical, 95 %), as a negative ratio per step of the basis; null if steps never lost. */
  var95: number | null;
  /** The best and the worst single step, as ratios. */
  bestStep: number | null;
  worstStep: number | null;
  /** Share of steps that gained, 0 to 1. */
  upShare: number | null;
  /** Why volatility and Sharpe ratio are missing. */
  unavailable?: string;
}

/** The value below which `p` of the sorted-in-place values lie, linear between neighbours. */
export function quantile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function computeMetrics(points: Point[]): Metrics {
  const first = points[0];
  const last = points[points.length - 1];
  const totalReturn = points.length >= 2 && first.value !== 0 ? last.value / first.value - 1 : null;
  let maxDrawdown: number | null = null;
  if (points.length >= 2) {
    let peak = -Infinity;
    maxDrawdown = 0;
    for (const p of points) {
      peak = Math.max(peak, p.value);
      if (peak > 0) maxDrawdown = Math.min(maxDrawdown, p.value / peak - 1);
    }
  }
  const base: Metrics = {
    basis: null, periodsPerYear: null, totalReturn, volatility: null, maxDrawdown, sharpe: null,
    sortino: null, calmar: null, var95: null, bestStep: null, worstStep: null, upShare: null,
  };

  for (const basis of LADDER) {
    const r = returnsOf(resample(points, basis));
    if (r.length < MIN_RETURNS) continue;
    const ppy = PERIODS[basis];
    const vol = stdev(r) * Math.sqrt(ppy);
    const volatility = Number.isFinite(vol) ? vol : null;
    const sharpe = volatility !== null && volatility > FLAT ? (mean(r) * ppy) / volatility : null;
    const finite = (x: number | null) => (x !== null && Number.isFinite(x) ? x : null);
    const downside = Math.sqrt(r.reduce((a, x) => a + Math.min(x, 0) ** 2, 0) / r.length) * Math.sqrt(ppy);
    const sortino = downside > FLAT ? (mean(r) * ppy) / downside : null;
    const grown = last.value / first.value;
    const annual = grown > 0 && first.value > 0 ? grown ** (ppy / r.length) - 1 : null;
    const calmar = annual !== null && maxDrawdown !== null && maxDrawdown < -FLAT ? annual / -maxDrawdown : null;
    const q = quantile(r, 0.05);
    return {
      ...base, basis, periodsPerYear: ppy, volatility: volatility === null ? null : volatility,
      sharpe: finite(sharpe), sortino: finite(sortino), calmar: finite(calmar),
      var95: q < 0 ? q : null, bestStep: Math.max(...r), worstStep: Math.min(...r),
      upShare: r.filter((x) => x > 0).length / r.length,
    };
  }
  return { ...base, unavailable: `Für Volatilität und Sharpe-Ratio liegen zu wenige Werte vor (mindestens ${MIN_RETURNS} Renditen nötig).` };
}

function pearson(a: number[], b: number[]): number | null {
  const ma = mean(a);
  const mb = mean(b);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  if (aa < FLAT || bb < FLAT) return null;
  const r = ab / Math.sqrt(aa * bb);
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : null;
}

/** Returns of two curves over the buckets both have, for the coarsest basis that gives enough of them. */
function commonReturns(a: Point[], b: Point[]): { basis: Basis; x: number[]; y: number[] } | null {
  for (const basis of LADDER) {
    const bb = new Map(bucketed(b, basis).map((p) => [p.key, p.value]));
    const both = bucketed(a, basis).filter((p) => bb.has(p.key));
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 1; i < both.length; i++) {
      const ya0 = both[i - 1].value;
      const yb0 = bb.get(both[i - 1].key)!;
      if (ya0 === 0 || yb0 === 0) continue;
      x.push(both[i].value / ya0 - 1);
      y.push(bb.get(both[i].key)! / yb0 - 1);
    }
    if (x.length >= MIN_RETURNS) return { basis, x, y };
  }
  return null;
}

export interface Correlation {
  ids: number[];
  /** The finest basis any pair needed; null when no pair could be measured. */
  basis: Basis | null;
  matrix: (number | null)[][];
}

export function correlationMatrix(curves: { id: number; points: Point[] }[]): Correlation {
  const n = curves.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : null)));
  let finest = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const common = commonReturns(curves[i].points, curves[j].points);
      if (!common) continue;
      const r = pearson(common.x, common.y);
      matrix[i][j] = matrix[j][i] = r;
      if (r !== null) finest = Math.max(finest, LADDER.indexOf(common.basis));
    }
  }
  return { ids: curves.map((c) => c.id), basis: finest < 0 ? null : LADDER[finest], matrix };
}

export interface Relative {
  basis: Basis;
  /** Slope of the depot's steps against the benchmark's steps. */
  beta: number | null;
  /** Annualized excess return over what beta explains (Jensen, without a risk-free rate). */
  alpha: number | null;
  /** Annualized volatility of the difference of the steps. */
  trackingError: number | null;
  /** Annualized mean difference over the tracking error. */
  informationRatio: number | null;
  /** Share of steps in which the depot did better than the benchmark. */
  hitShare: number;
}

/** How a curve moved against a benchmark over the steps both have, or null when there are too few. */
export function relativeTo(curve: Point[], benchmark: Point[]): Relative | null {
  const common = commonReturns(curve, benchmark);
  if (!common) return null;
  const { basis, x, y } = common;
  const ppy = PERIODS[basis];
  const my = mean(y);
  const mx = mean(x);
  let cov = 0;
  let varY = 0;
  for (let i = 0; i < x.length; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    varY += (y[i] - my) ** 2;
  }
  const beta = varY > FLAT ? cov / varY : null;
  const alpha = beta === null ? null : (mx - beta * my) * ppy;
  const diff = x.map((v, i) => v - y[i]);
  const te = stdev(diff) * Math.sqrt(ppy);
  const finite = (v: number | null) => (v !== null && Number.isFinite(v) ? v : null);
  return {
    basis,
    beta: finite(beta),
    alpha: finite(alpha),
    trackingError: finite(te),
    informationRatio: te > FLAT ? finite((mean(diff) * ppy) / te) : null,
    hitShare: diff.filter((d) => d > 0).length / diff.length,
  };
}
