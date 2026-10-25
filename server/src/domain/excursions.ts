import type { Bar } from "../data/marketdata.js";
import type { BarsAccess, JournalTrade, OpenLot } from "./journal.js";
import { type Cent, roundCent } from "./money.js";

const DAY = 86400;
const dayOf = (t: number) => Math.floor(t / DAY) * DAY;
/** The sampled closes kept for the little chart of a trade. */
const PATH_POINTS = 40;

/** What the excursions read: the journal's access plus the bars of a stretch, and how long one bar is. */
export interface ExcursionBars extends BarsAccess {
  /** Bars with `fromT <= t < toT`, oldest first. */
  barsBetween(symbol: string, fromT: number, toT: number): Bar[];
  /** 60 for minute bars, 86400 for daily bars. */
  barSeconds: number;
}

export interface Excursion {
  /** The deepest the price stood below the buy price, in percent of it (0 or more). Null without any bar. */
  maePct: number | null;
  /** The highest it stood above the buy price, in percent. */
  mfePct: number | null;
  /** The same two as an amount, scaled to the cost of the lot (an approximation for foreign currency). */
  maeCents: Cent | null;
  mfeCents: Cent | null;
  /** How much of the possible gain the exit took: (exit - buy) / (high - buy). Null when the price never stood above the buy price. */
  efficiency: number | null;
  /** Where the buy stood in the range of its day: 0 is the day's low, 1 its high. Null when that day is not over or flat. */
  entryPosition: number | null;
  /** The bars the figures rest on. */
  bars: number;
  /** The same money in the benchmark over the same time. Null when not computable. */
  benchmark: { symbol: string; pnl: Cent; diff: Cent } | null;
  /** Sampled closes from entry to exit for the chart. */
  path: number[];
}

export interface ExcursionSummary {
  n: number;
  medianMaePct: number | null;
  medianMfePct: number | null;
  medianEfficiency: number | null;
  /** How many trades took less than 0, up to 25, 50, 75 and up to 100 % of their possible gain. */
  efficiencyBuckets: { label: string; count: number }[];
  /** Trades with a benchmark comparison, and how many of them beat the benchmark. */
  benchmark: { n: number; beat: number };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const sample = (xs: number[], n: number) => {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
};

/**
 * MAE, MFE, exit efficiency, entry quality and the benchmark check for one holding: `qty` bought at `buyPrice` at
 * `openedSim` and sold at `exitPrice` at `endSim` (or, for an open lot, the price now). Prices are the instrument's own,
 * without fees; amounts scale the percentages to `cost`. Reads bars that are over at `min(endSim, s)` only.
 * Pure.
 */
export function holdingExcursion(input: {
  symbol: string;
  buyPrice: number;
  exitPrice: number;
  openedSim: number;
  endSim: number;
  cost: Cent;
  s: number;
  bars: ExcursionBars;
  benchmark: string | null;
}): Excursion {
  const { symbol, buyPrice, exitPrice, openedSim, bars, cost, s } = input;
  const end = Math.min(input.endSim, s);
  const sec = bars.barSeconds;
  // Bars that ended after the entry and are over at the exit: the time the position was held.
  const held = bars
    .barsBetween(symbol, openedSim - sec, end)
    .filter((b) => b.t + sec > openedSim && b.t + sec <= end);
  let lo = Math.min(buyPrice, exitPrice);
  let hi = Math.max(buyPrice, exitPrice);
  for (const b of held) {
    lo = Math.min(lo, b.l);
    hi = Math.max(hi, b.h);
  }
  const ok = held.length > 0 && buyPrice > 0;
  const mae = ok ? Math.max(0, (buyPrice - lo) / buyPrice) : null;
  const mfe = ok ? Math.max(0, (hi - buyPrice) / buyPrice) : null;

  // The range of the buy day, from bars that are over.
  let entryPosition: number | null = null;
  const day = dayOf(openedSim);
  if (s >= day + DAY) {
    const dayBars = bars.barsBetween(symbol, day, day + DAY).filter((b) => b.t + sec <= s);
    if (dayBars.length > 0) {
      const dLo = Math.min(...dayBars.map((b) => b.l));
      const dHi = Math.max(...dayBars.map((b) => b.h));
      if (dHi > dLo) entryPosition = round4(Math.min(1, Math.max(0, (buyPrice - dLo) / (dHi - dLo))));
    }
  }

  let benchmark: Excursion["benchmark"] = null;
  if (input.benchmark && cost > 0) {
    const a = bars.lastCompleteBar(input.benchmark, openedSim);
    const b = bars.lastCompleteBar(input.benchmark, end);
    if (a && b && a.c > 0 && b.t >= a.t) {
      const pnl = roundCent(cost * (b.c / a.c - 1));
      const own = roundCent(cost * (exitPrice / buyPrice - 1));
      benchmark = { symbol: input.benchmark, pnl, diff: own - pnl };
    }
  }

  return {
    maePct: mae === null ? null : round2(mae * 100),
    mfePct: mfe === null ? null : round2(mfe * 100),
    maeCents: mae === null ? null : roundCent(cost * mae),
    mfeCents: mfe === null ? null : roundCent(cost * mfe),
    efficiency: ok && hi > buyPrice ? round4((exitPrice - buyPrice) / (hi - buyPrice)) : null,
    entryPosition,
    bars: held.length,
    benchmark,
    path: sample([buyPrice, ...held.map((b) => b.c), exitPrice], PATH_POINTS),
  };
}

/** The excursion of a closed trade. */
export const tradeExcursion = (t: JournalTrade, s: number, bars: ExcursionBars, benchmark: string | null): Excursion =>
  holdingExcursion({ symbol: t.symbol, buyPrice: t.buyPrice, exitPrice: t.sellPrice, openedSim: t.openedSim, endSim: t.closedSim, cost: t.buyCost, s, bars, benchmark });

/** The excursion of a lot that is still held, up to the last price known at `s`. Null without a price. */
export function openExcursion(lot: OpenLot, s: number, bars: ExcursionBars, benchmark: string | null): Excursion | null {
  const now = bars.lastCompleteBar(lot.symbol, s);
  if (!now) return null;
  return holdingExcursion({ symbol: lot.symbol, buyPrice: lot.buyPrice, exitPrice: now.c, openedSim: lot.openedSim, endSim: s, cost: lot.cost, s, bars, benchmark });
}

const BUCKETS = [
  { label: "unter 0 %", test: (e: number) => e < 0 },
  { label: "0 bis 25 %", test: (e: number) => e >= 0 && e < 0.25 },
  { label: "25 bis 50 %", test: (e: number) => e >= 0.25 && e < 0.5 },
  { label: "50 bis 75 %", test: (e: number) => e >= 0.5 && e < 0.75 },
  { label: "75 bis 100 %", test: (e: number) => e >= 0.75 },
];

/** Medians and the distribution of the exit efficiency over closed trades. */
export function summarize(list: Excursion[]): ExcursionSummary {
  const measured = list.filter((e) => e.maePct !== null);
  const eff = measured.flatMap((e) => (e.efficiency === null ? [] : [e.efficiency]));
  const bench = list.filter((e) => e.benchmark !== null);
  return {
    n: measured.length,
    medianMaePct: median(measured.map((e) => e.maePct as number)),
    medianMfePct: median(measured.map((e) => e.mfePct as number)),
    medianEfficiency: median(eff),
    efficiencyBuckets: BUCKETS.map((b) => ({ label: b.label, count: eff.filter(b.test).length })),
    benchmark: { n: bench.length, beat: bench.filter((e) => e.benchmark!.diff > 0).length },
  };
}
