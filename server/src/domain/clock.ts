import type { Archive } from "../data/archive.js";

export type Tempo = 1 | 5 | 30 | 60;

/** A market counts as open while one of its instruments had a bar finish this recently. */
export const OPEN_WINDOW_S = 300;

/** The simulation time after `realMs` of real time, in whole seconds. */
export function advance(s: number, tempo: Tempo, realMs: number): number {
  return Math.floor(s + (tempo * realMs) / 1000);
}

/**
 * Over a night or a weekend nothing trades, and playing it out second by second would be
 * waiting. Returns `s` while any of `symbols` is open, otherwise the moment the first bar
 * after the gap is complete (`t + 60`, not `t`: at `t` the bar is not done, the market would
 * still read as closed and the next tick would jump again). `undefined` when the archive has
 * no later bar. `symbols` must leave out round-the-clock series such as the exchange rate.
 */
export function skipClosed(s: number, symbols: string[], archive: Archive): number | undefined {
  for (const symbol of symbols) {
    const last = archive.lastCompleteBar(symbol, s);
    if (last && s - (last.t + 60) <= OPEN_WINDOW_S) return s;
  }
  let next: number | undefined;
  for (const symbol of symbols) {
    const bar = archive.nextBarAfter(symbol, s);
    if (bar && (next === undefined || bar.t < next)) next = bar.t;
  }
  return next === undefined ? undefined : next + 60;
}
