import type { Archive } from "../data/archive.js";

export type Tempo = 1 | 5 | 30 | 60;

/** A market counts as open while one of its instruments had a bar finish this recently. */
export const OPEN_WINDOW_S = 300;

/** A live simulation more than this far behind the live limit catches up. */
export const CATCH_UP_LAG_S = 120;

/** The present counts as reached when the newest known bar is at most this far behind the live limit. */
export const LIVE_EDGE_S = 1800;

/**
 * At that edge the clock stays this far behind the newest bar: the bars of one refresh arrive
 * instrument by instrument, and a minute still missing for one of them must not be skipped.
 */
export const LIVE_MARGIN_S = 60;

/** The latest simulation time that may be shown: now minus the delay of the price source. */
export function liveLimit(nowS: number, delayS: number): number {
  return Math.floor(nowS - delayS);
}

/**
 * The tempo a tick runs at. A replay runs at the tempo that was chosen. A live simulation
 * runs at the catch-up tempo while it is more than CATCH_UP_LAG_S behind the limit and in
 * real time otherwise.
 */
export function effectiveTempo(live: boolean, tempo: Tempo, lagS: number, catchUpTempo: number): number {
  if (!live) return tempo;
  return lagS > CATCH_UP_LAG_S ? catchUpTempo : 1;
}

/** The simulation time after `realMs` of real time, in whole seconds. */
export function advance(s: number, tempo: number, realMs: number): number {
  return Math.floor(s + (tempo * realMs) / 1000);
}

/**
 * Like `advance`, but the part of a second a short tick leaves over is carried to the next tick.
 * Rounding every tick down made the clock stand still at tempo 1 with ticks of 250 ms, and run
 * slow at tempo 5 and 30. The carry is in simulated seconds, which are exact where milliseconds
 * go through a division by the tempo.
 */
export function advanceCarry(s: number, tempo: number, realMs: number, carry: number): { s: number; carry: number } {
  const total = (tempo * realMs) / 1000 + carry;
  const whole = Math.floor(total);
  return { s: s + whole, carry: total - whole };
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
