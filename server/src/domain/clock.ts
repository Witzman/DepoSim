import type { VenueInfo } from "../config.js";
import type { Archive } from "../data/archive.js";
import { localTime, sessionFor } from "./venues.js";

export type Tempo = 1 | 5 | 30 | 60 | 120 | 300;

/** The two fastest tempi: only while no order is open, because an order would be passed over unseen. */
export const TIME_LAPSE: readonly Tempo[] = [120, 300];

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

/** A jump the person can ask for. `candle` is one bar, the others end at a time of the day of a market. */
export type JumpKind = "candle" | "hour" | "close" | "open" | "day";

/** UTC second of local "HH:MM" on the local ISO `day` in the zone. Two corrections settle the offset, also across a change of clocks. */
export function localToUtc(timeZone: string, day: string, hhmm: string): number {
  const want = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  let t = Date.parse(`${day}T${hhmm}:00Z`) / 1000;
  for (let i = 0; i < 3; i++) {
    const got = localTime(timeZone, t);
    const days = Math.round((Date.parse(`${got.day}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
    const diff = got.minutes + days * 1440 - want;
    if (diff === 0) break;
    t -= diff * 60;
  }
  return t;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The time a jump of this kind ends at, by the hours of a market (holidays and short days included). Pure.
 * `close`: the next close of the market after `s`; `open`: its next open after `s`; `day`: the next local midnight;
 * `hour`: one hour on. `candle` is not by hours and is answered from the bars (see `SessionService.jump`).
 * Undefined if the market has no session in the next two weeks.
 */
export function nextStop(kind: Exclude<JumpKind, "candle">, s: number, venue: VenueInfo): number | undefined {
  if (kind === "hour") return s + 3600;
  const today = localTime(venue.timeZone, s).day;
  if (kind === "day") return localToUtc(venue.timeZone, addDays(today, 1), "00:00");
  for (let i = 0; i < 14; i++) {
    const day = addDays(today, i);
    const session = sessionFor(venue, day);
    if (!session.trading) continue;
    const at = localToUtc(venue.timeZone, day, kind === "close" ? session.closes : session.opens);
    if (at > s) return at;
  }
  return undefined;
}
