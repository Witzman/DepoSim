import { type Basis, LADDER, MIN_RETURNS, PERIODS, type Point, bucketed } from "./metrics.js";

/** One held position: its weight (value share among the positions) and its price in EUR over the window. */
export interface HeldSeries {
  symbol: string;
  /** Value of the position now, in cent. */
  value: number;
  /** Price in EUR (a USD price converted at the rate of the time), oldest first, up to the simulation time and not beyond. */
  points: Point[];
}

export interface Concentration {
  /** Shares of the invested value, largest first. */
  weights: { symbol: string; weight: number }[];
  largest: number;
  top3: number;
  /** Sum of squared weights: 1 for one position, 1/n for n equal ones. */
  hhi: number;
  /** 1 / HHI: how many equally large positions the depot acts like in its weights. */
  effectiveCount: number;
}

export interface RiskLine {
  symbol: string;
  weight: number;
  /** Annualised volatility of the position alone. */
  volatility: number;
  /** Share of the depot's variance this position brings; the lines sum to 1. */
  riskShare: number;
}

export interface Measured {
  basis: Basis;
  /** The returns behind the numbers. */
  n: number;
  /** The last point in time that went in; never later than the simulation time. */
  until: number;
  symbols: string[];
  /** Correlation of the positions' returns, in `symbols` order; the diagonal is 1. */
  matrix: number[][];
  lines: RiskLine[];
  /** Annualised volatility of the positions taken together. */
  volatility: number;
  /** Weighted single volatilities over the depot's volatility: 1 for no gain from mixing, larger is better. */
  ratio: number;
  /** Positions left out because they share too few values with the others. */
  left: string[];
  /** Plain-language remarks, e.g. a pair that moves almost the same. */
  remarks: string[];
}

export interface Diversification {
  concentration: Concentration;
  /** Null, with the reason, when there are too few common values. */
  measured: Measured | null;
  reason?: string;
}

const NEAR_SAME = 0.8;

export function concentrationOf(items: { symbol: string; value: number }[]): Concentration {
  const total = items.reduce((a, i) => a + Math.max(i.value, 0), 0);
  const weights = items
    .map((i) => ({ symbol: i.symbol, weight: total > 0 ? Math.max(i.value, 0) / total : 0 }))
    .sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol));
  const hhi = weights.reduce((a, w) => a + w.weight ** 2, 0);
  return {
    weights,
    largest: weights[0]?.weight ?? 0,
    top3: weights.slice(0, 3).reduce((a, w) => a + w.weight, 0),
    hhi,
    effectiveCount: hhi > 0 ? 1 / hhi : 0,
  };
}

/** Sample covariance of equally long series. */
function covariance(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - ma) * (b[i] - mb);
  return sum / (a.length - 1);
}

/** Returns of every series over the buckets all of them have, or null if fewer than MIN_RETURNS. */
function commonReturns(series: HeldSeries[], basis: Basis): { returns: number[][]; until: number } | null {
  const maps = series.map((s) => new Map(bucketed(s.points, basis).map((p) => [p.key, p])));
  const keys = [...maps[0].keys()].filter((k) => maps.every((m) => m.has(k)));
  const returns: number[][] = series.map(() => []);
  let until = 0;
  for (let i = 1; i < keys.length; i++) {
    const before = maps.map((m) => m.get(keys[i - 1])!.value);
    if (before.some((v) => !(v > 0))) continue;
    maps.forEach((m, j) => returns[j].push(m.get(keys[i])!.value / before[j] - 1));
  }
  for (const m of maps) until = Math.max(until, ...[...m.values()].filter((p) => keys.includes(p.key)).map((p) => p.t));
  return returns[0].length >= MIN_RETURNS ? { returns, until } : null;
}

/** Concentration of the weights, and what the returns say about how the positions mix. */
export function diversify(held: HeldSeries[]): Diversification | null {
  if (held.length === 0) return null;
  const concentration = concentrationOf(held);
  if (held.length === 1) {
    return { concentration, measured: null, reason: "Mit einer Position gibt es nichts zu mischen." };
  }

  // Positions with the fewest values go first when the others do not share enough with them.
  let pool = [...held];
  const left: string[] = [];
  while (pool.length >= 2) {
    for (const basis of LADDER) {
      const common = commonReturns(pool, basis);
      if (!common) continue;
      return { concentration, measured: measure(pool, basis, common.returns, common.until, left) };
    }
    const sparse = pool.reduce((lo, s) => (s.points.length < lo.points.length ? s : lo));
    left.push(sparse.symbol);
    pool = pool.filter((s) => s !== sparse);
  }
  return { concentration, measured: null, reason: `Noch zu wenige gemeinsame Werte (mindestens ${MIN_RETURNS} Renditen nötig).` };
}

function measure(pool: HeldSeries[], basis: Basis, returns: number[][], until: number, left: string[]): Measured {
  const total = pool.reduce((a, s) => a + Math.max(s.value, 0), 0);
  const w = pool.map((s) => (total > 0 ? Math.max(s.value, 0) / total : 1 / pool.length));
  const k = pool.length;
  const cov = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => covariance(returns[i], returns[j])));
  const sigmaW = cov.map((row) => row.reduce((a, c, j) => a + c * w[j], 0));
  const variance = w.reduce((a, wi, i) => a + wi * sigmaW[i], 0);
  const ppy = PERIODS[basis];
  const vol = (v: number) => Math.sqrt(Math.max(v, 0) * ppy);
  const single = cov.map((row, i) => vol(row[i]));
  const matrix = cov.map((row, i) => row.map((c, j) => (i === j ? 1 : Math.max(-1, Math.min(1, c / Math.sqrt(row[i] * cov[j][j]) || 0)))));
  const volatility = vol(variance);
  const lines = pool.map((s, i) => ({
    symbol: s.symbol, weight: w[i], volatility: single[i], riskShare: variance > 0 ? (w[i] * sigmaW[i]) / variance : w[i],
  }));
  const ratio = volatility > 0 ? w.reduce((a, wi, i) => a + wi * single[i], 0) / volatility : 1;
  const remarks: string[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      if (matrix[i][j] >= NEAR_SAME) {
        remarks.push(`${pool[i].symbol} und ${pool[j].symbol} laufen zu ${matrix[i][j].toFixed(1).replace(".", ",")} gleich: wenig Streuung.`);
      }
    }
  }
  const top = [...lines].sort((a, b) => b.riskShare - a.riskShare)[0];
  if (top && top.riskShare - top.weight >= 0.1) {
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    remarks.push(`${top.symbol}: ${pct(top.weight)} des Geldes, ${pct(top.riskShare)} des Risikos.`);
  }
  return {
    basis, n: returns[0].length, until, symbols: pool.map((s) => s.symbol), matrix, lines, volatility, ratio, left: [...left], remarks,
  };
}
