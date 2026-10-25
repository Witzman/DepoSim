import type { Db } from "../db.js";
import type { Bar } from "./marketdata.js";

const DAY = 86400;
const secondsOf = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

/**
 * The daily prices of a simulation that plays one trading day per step (#54). A bar is stamped with the
 * UTC second its day begins; it is finished at `t + 86400`. Read-only: `events.ts` fills the table.
 */
export interface DailyArchive {
  /** Days that begin in [fromT, toT), oldest first. */
  between(symbol: string, fromT: number, toT: number): Bar[];
  /** The newest bar whose day is over at `s` (`t + 86400 <= s`). */
  lastComplete(symbol: string, s: number): Bar | undefined;
  /** The first bar that begins after `t`. */
  nextAfter(symbol: string, t: number): Bar | undefined;
  /** The first and the last day stored, "YYYY-MM-DD". */
  span(symbol: string): { first: string; last: string } | undefined;
}

interface Row { day: string; o: number; h: number; l: number; c: number; v: number }
const toBar = (r: Row): Bar => ({ t: secondsOf(r.day), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
const dayOfT = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export function createDailyArchive(db: Db): DailyArchive {
  const between = db.prepare("select day, o, h, l, c, v from daily_bars where symbol = ? and day >= ? and day < ? order by day");
  const lastBefore = db.prepare("select day, o, h, l, c, v from daily_bars where symbol = ? and day <= ? order by day desc limit 1");
  const firstFrom = db.prepare("select day, o, h, l, c, v from daily_bars where symbol = ? and day > ? order by day limit 1");
  const span = db.prepare("select min(day) as first, max(day) as last from daily_bars where symbol = ?");
  return {
    between: (symbol, fromT, toT) => (between.all(symbol, dayOfT(fromT), dayOfT(toT)) as Row[]).map(toBar),
    // A day is over at `s` when its next midnight is at or before `s`: its day string is at most the day of `s - 86400`.
    lastComplete: (symbol, s) => {
      const r = lastBefore.get(symbol, dayOfT(s - DAY)) as Row | undefined;
      return r ? toBar(r) : undefined;
    },
    nextAfter: (symbol, t) => {
      const r = firstFrom.get(symbol, dayOfT(t)) as Row | undefined;
      return r ? toBar(r) : undefined;
    },
    span: (symbol) => {
      const r = span.get(symbol) as { first: string | null; last: string | null };
      return r.first && r.last ? { first: r.first, last: r.last } : undefined;
    },
  };
}
