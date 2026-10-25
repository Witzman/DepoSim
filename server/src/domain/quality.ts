import type { Bar } from "../data/marketdata.js";

/**
 * Plausibility of minute bars (#50). Pure functions: nothing here reads or writes the archive.
 * A bar is never corrected or deleted by these checks; the caller marks it.
 *
 * - `struct`: the bar is impossible (high under its body, a price of 0 or less, not a number). Not stored.
 * - `spike`:  one minute far off the price around it, taken back in the next. The simulation does not trade on it.
 * - `daily`:  the last minute of a day against the daily close of the same day. A hint only.
 * - `dup`, `time`: the source sent a minute twice or out of order. A hint only.
 */
export type FlagKind = "struct" | "spike" | "daily" | "dup" | "time";

export interface Flag {
  t: number;
  kind: FlagKind;
  detail: string;
}

/** The flags the simulation takes seriously: a flagged bar does not trigger an order and gives no price. */
export const BLOCKING_KINDS: readonly FlagKind[] = ["spike"];

export const KIND_LABEL: Record<FlagKind, string> = {
  struct: "Strukturfehler (nicht gespeichert)",
  spike: "Ausreißer (nicht handelbar)",
  daily: "Abweichung vom Tagesschluss",
  dup: "doppelte Minute",
  time: "Zeit rückwärts",
};

/** A spike must move the price by at least this much (log return), whatever the recent calm says. */
export const SPIKE_MIN_MOVE = 0.05;
/** ... and by this many standard deviations of the recent minute returns. */
export const SPIKE_SIGMAS = 10;
/** The next minute must take back all but this share of the move. */
const SPIKE_KEEPS = 0.2;
/** Minutes of returns before a bar that make up the standard deviation. */
const SIGMA_WINDOW = 30;
/** A "next minute" further away than this is not the next minute (thin ETFs skip minutes). */
const NEXT_WITHIN_S = 600;

const finitePositive = (x: number) => typeof x === "number" && Number.isFinite(x) && x > 0;

/** Median of a list (it is sorted in place). */
function median(xs: number[]): number {
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/** Robust standard deviation of `returns[from..to)`; 0 if there are fewer than 5 values. */
function spread(returns: number[], from: number, to: number): number {
  if (to - from < 5) return 0;
  const xs = returns.slice(from, to);
  const mid = median(xs.slice());
  return 1.4826 * median(xs.map((x) => Math.abs(x - mid)));
}

/** Why a bar is impossible, or null if its numbers hang together. */
export function checkBar(b: Bar): string | null {
  const price = { o: b.o, h: b.h, l: b.l, c: b.c };
  for (const [name, x] of Object.entries(price)) {
    if (typeof x !== "number" || !Number.isFinite(x)) return `${name} ist keine Zahl`;
    if (x <= 0) return `${name} ist ${x}, ein Preis muss über 0 liegen`;
  }
  if (typeof b.v !== "number" || !Number.isFinite(b.v) || b.v < 0) return "Volumen ist keine Zahl oder negativ";
  if (b.h < Math.max(b.o, b.c)) return `Hoch ${b.h} liegt unter Eröffnung/Schluss ${Math.max(b.o, b.c)}`;
  if (b.l > Math.min(b.o, b.c)) return `Tief ${b.l} liegt über Eröffnung/Schluss ${Math.min(b.o, b.c)}`;
  if (b.h < b.l) return `Hoch ${b.h} liegt unter Tief ${b.l}`;
  return null;
}

/** Duplicated minutes and minutes that go back in time, in the order the source sent them. */
export function findOrderProblems(bars: Bar[]): Flag[] {
  const out: Flag[] = [];
  const seen = new Set<number>();
  let top = -Infinity;
  for (const b of bars) {
    if (seen.has(b.t)) out.push({ t: b.t, kind: "dup", detail: "Minute kam mehrfach von der Quelle" });
    else if (b.t < top) out.push({ t: b.t, kind: "time", detail: "Minute kam nach einer späteren" });
    seen.add(b.t);
    if (b.t > top) top = b.t;
  }
  return out;
}

/**
 * Spikes in bars sorted by time (distinct minutes). The bar's own extremes count, not only its close:
 * a single bad high or low is a spike too. A spike needs a bar before it and a next minute after it.
 * A real jump that stays (earnings gap) is not one: the next minute is at the new level.
 * `sigma` of each bar comes from the close-to-close returns of up to 30 minutes before it, as a robust
 * spread (median absolute deviation), so an earlier spike does not blind the check for the next one.
 */
export function findSpikes(bars: Bar[], from = 0): Flag[] {
  const out: Flag[] = [];
  const returns: number[] = []; // log return into bar i, index i (0 for the first)
  for (let i = 1; i < bars.length; i++) returns[i] = Math.log(bars[i].c / bars[i - 1].c);
  for (let i = Math.max(1, from); i < bars.length - 1; i++) {
    const prev = bars[i - 1];
    const b = bars[i];
    const next = bars[i + 1];
    if (next.t - b.t > NEXT_WITHIN_S) continue;
    const ref = prev.c;
    // the largest excursion of any price of the bar from the price before it
    let dev = 0;
    for (const x of [b.o, b.h, b.l, b.c]) {
      const d = Math.log(x / ref);
      if (Math.abs(d) > Math.abs(dev)) dev = d;
    }
    if (Math.abs(dev) < SPIKE_MIN_MOVE) continue;
    const sigma = spread(returns, Math.max(1, i - SIGMA_WINDOW), i);
    if (Math.abs(dev) < SPIKE_SIGMAS * sigma) continue;
    // Taken back: the next minute opens and closes close to the old price again.
    const back = Math.abs(dev) * SPIKE_KEEPS;
    if (Math.abs(Math.log(next.o / ref)) <= back && Math.abs(Math.log(next.c / ref)) <= back) {
      out.push({ t: b.t, kind: "spike", detail: `${(dev * 100).toFixed(1).replace(".", ",")} % gegen den Vorgänger, in der nächsten Minute zurück` });
    }
  }
  return out;
}

/** How far the last minute of a day may be from the daily close: Xetra ETFs 0,5 %, everything else 1 %. */
export function dailyTolerance(venue: string, kind: string | undefined): number {
  return venue === "XETRA" && kind === "ETF" ? 0.005 : 0.01;
}

/** The close of the day's last minute against the daily close; a flag on that minute if it is further off than `tolerance`. */
export function compareToDaily(minuteBars: Bar[], dailyClose: number, tolerance: number): Flag | null {
  if (minuteBars.length === 0 || !finitePositive(dailyClose)) return null;
  const last = minuteBars[minuteBars.length - 1];
  const diff = Math.abs(last.c - dailyClose) / dailyClose;
  if (diff <= tolerance) return null;
  return { t: last.t, kind: "daily", detail: `Schluss ${last.c} gegen Tagesschluss ${dailyClose} (${(diff * 100).toFixed(2).replace(".", ",")} %)` };
}
