import type { Db } from "../db.js";
import { type Bar, type MarketData, MarketDataError } from "./marketdata.js";

const DAY = 86400;

export interface Archive {
  /** Fetches the day once per symbol. A day that is not over yet is fetched again next time. */
  ensureDay(symbol: string, dayStartT: number): Promise<void>;
  /** Bars with `fromT <= t < toT`, oldest first. */
  barsBetween(symbol: string, fromT: number, toT: number): Bar[];
  /** The newest bar whose minute is over at `s`, however long ago it was. */
  lastCompleteBar(symbol: string, s: number): Bar | undefined;
  /** The newest `limit` bars that are complete at `s`, oldest first. */
  barsBefore(symbol: string, s: number, limit: number): Bar[];
  /** The first bar with `t` strictly after `s`. */
  nextBarAfter(symbol: string, s: number): Bar | undefined;
}

export interface ArchiveOptions {
  /** Pause between two calls to the source; the calls never overlap. */
  minGapMs?: number;
  /** Current time in UTC seconds. Injected so the "day is not over" rule can be tested. */
  now?: () => number;
}

export function createArchive(db: Db, source: MarketData, opts: ArchiveOptions = {}): Archive {
  const minGapMs = opts.minGapMs ?? 500;
  const now = opts.now ?? (() => Date.now() / 1000);

  const selectDay = db.prepare("select complete from fetched_days where symbol = ? and day_start = ?");
  const insertBar = db.prepare("insert or ignore into bars (symbol, t, o, h, l, c, v) values (?, ?, ?, ?, ?, ?, ?)");
  const markDay = db.prepare(
    "insert into fetched_days (symbol, day_start, complete) values (?, ?, ?) " +
      "on conflict (symbol, day_start) do update set complete = excluded.complete",
  );
  const store = db.transaction((symbol: string, dayStartT: number, bars: Bar[], complete: number) => {
    for (const b of bars) insertBar.run(symbol, b.t, b.o, b.h, b.l, b.c, b.v);
    markDay.run(symbol, dayStartT, complete);
  });

  // One source call at a time, with a pause between calls.
  let chain: Promise<unknown> = Promise.resolve();
  let lastEnd = 0;
  function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = lastEnd + minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        lastEnd = Date.now();
      }
    });
    chain = run.catch(() => undefined);
    return run;
  }

  const inflight = new Map<string, Promise<void>>();

  return {
    ensureDay(symbol, dayStartT) {
      const key = `${symbol}:${dayStartT}`;
      const running = inflight.get(key);
      if (running) return running;

      const p = (async () => {
        const row = selectDay.get(symbol, dayStartT) as { complete: number } | undefined;
        if (row?.complete === 1) return;
        const dayEnd = dayStartT + DAY;
        let bars: Bar[];
        try {
          bars = await throttled(() => source.bars(symbol, dayStartT, dayEnd));
        } catch (err) {
          // "No data" is a holiday or a day without trading, not a failure. Anything else is.
          if (!(err instanceof MarketDataError && err.kind === "no_data")) throw err;
          bars = [];
        }
        // The source also sends the minute that is still running, with incomplete values, and
        // `insert or ignore` would keep them for good. Only finished minutes are stored; the
        // rest is fetched again, because a day that is not over is fetched again.
        const finished = bars.filter((b) => b.t + 60 <= now());
        store(symbol, dayStartT, finished, now() >= dayEnd ? 1 : 0);
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },

    barsBetween(symbol, fromT, toT) {
      return db
        .prepare("select t, o, h, l, c, v from bars where symbol = ? and t >= ? and t < ? order by t")
        .all(symbol, fromT, toT) as Bar[];
    },

    lastCompleteBar(symbol, s) {
      return db
        .prepare("select t, o, h, l, c, v from bars where symbol = ? and t <= ? order by t desc limit 1")
        .get(symbol, s - 60) as Bar | undefined;
    },

    barsBefore(symbol, s, limit) {
      const rows = db
        .prepare("select t, o, h, l, c, v from bars where symbol = ? and t <= ? order by t desc limit ?")
        .all(symbol, s - 60, limit) as Bar[];
      return rows.reverse();
    },

    nextBarAfter(symbol, s) {
      return db
        .prepare("select t, o, h, l, c, v from bars where symbol = ? and t > ? order by t limit 1")
        .get(symbol, s) as Bar | undefined;
    },
  };
}
