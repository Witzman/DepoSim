import { type Db, prep } from "../db.js";
import { type Bar, type MarketData, MarketDataError } from "./marketdata.js";
import { BLOCKING_KINDS, type Flag, type FlagKind, checkBar, compareToDaily, findOrderProblems, findSpikes } from "../domain/quality.js";

const DAY = 86400;

export interface Archive {
  /** Fetches the day once per symbol. A day that is not over yet is fetched again next time. */
  ensureDay(symbol: string, dayStartT: number): Promise<void>;
  /** Days in `[fromDayT, toDayT)` never fetched or not complete yet, newest first, then by symbol. */
  /** `skip` leaves out the (symbol, day) pairs on which the market does not trade. */
  missingDays(symbols: string[], fromDayT: number, toDayT: number, skip?: (symbol: string, dayStartT: number) => boolean): MissingDay[];
  /** Fetches one day from the source and stores it. Returns how many bars were stored; 0 is a day without trading. */
  fetchDay(symbol: string, dayStartT: number): Promise<number>;
  /** Bars with `fromT <= t < toT`, oldest first. */
  barsBetween(symbol: string, fromT: number, toT: number): Bar[];
  /**
   * The newest bar whose minute is over at `s`, however long ago it was. With `skipFlagged` a bar marked as an
   * outlier (#50) is passed over: the simulation prices and fills on the last unmarked bar.
   */
  lastCompleteBar(symbol: string, s: number, opts?: { skipFlagged?: boolean }): Bar | undefined;
  /** Runs the plausibility checks again over `[fromT, toT)` and replaces the spike and daily flags there. */
  recheck(symbol: string, fromT: number, toT: number): RecheckResult;
  /** Flags in `[fromT, toT)`, oldest first. */
  flagsBetween(symbol: string, fromT: number, toT: number, kinds?: readonly FlagKind[]): Flag[];
  /** The newest `limit` bars that are complete at `s`, oldest first. */
  barsBefore(symbol: string, s: number, limit: number): Bar[];
  /** The first bar with `t` strictly after `s`. */
  nextBarAfter(symbol: string, s: number): Bar | undefined;
}

export interface RecheckResult {
  bars: number;
  spike: number;
  daily: number;
}

export interface MissingDay {
  symbol: string;
  dayStart: number;
  state: "never" | "incomplete";
}

export interface ArchiveOptions {
  /** Pause between two calls to the source; the calls never overlap. */
  minGapMs?: number;
  /** Current time in UTC seconds. Injected so the "day is not over" rule can be tested. */
  now?: () => number;
  /** How far the last minute of a day may be from the daily close, as a share; 1 % where not given. */
  dailyTolerance?: (symbol: string) => number;
}

/** Minutes before the checked range that give the spike check its picture of the recent noise. */
const CONTEXT_BARS = 30;

export function createArchive(db: Db, source: MarketData, opts: ArchiveOptions = {}): Archive {
  const minGapMs = opts.minGapMs ?? 500;
  const now = opts.now ?? (() => Date.now() / 1000);

  const selectDay = prep(db, "select complete from fetched_days where symbol = ? and day_start = ?");
  const insertBar = prep(db, "insert or ignore into bars (symbol, t, o, h, l, c, v) values (?, ?, ?, ?, ?, ?, ?)");
  const markDay = prep(db, 
    "insert into fetched_days (symbol, day_start, complete) values (?, ?, ?) " +
      "on conflict (symbol, day_start) do update set complete = excluded.complete",
  );
  const store = db.transaction((symbol: string, dayStartT: number, bars: Bar[], complete: number) => {
    for (const b of bars) insertBar.run(symbol, b.t, b.o, b.h, b.l, b.c, b.v);
    markDay.run(symbol, dayStartT, complete);
  });

  const insertFlag = prep(db, "insert or replace into bar_flags (symbol, t, kind, detail) values (?, ?, ?, ?)");
  const dailyOf = prep(db, "select c from daily_bars where symbol = ? and day = ?");
  const rangeBars = prep(db, "select t, o, h, l, c, v from bars where symbol = ? and t >= ? and t < ? order by t");
  const tailBars = prep(db, "select t, o, h, l, c, v from bars where symbol = ? and t < ? order by t desc limit ?");
  const headBars = prep(db, "select t, o, h, l, c, v from bars where symbol = ? and t >= ? order by t limit 1");
  const spikeKinds = "('spike', 'daily')";
  const clearFlags = prep(db, `delete from bar_flags where symbol = ? and t >= ? and t < ? and kind in ${spikeKinds}`);
  const tolerance = opts.dailyTolerance ?? (() => 0.01);

  const recheck = db.transaction((symbol: string, fromT: number, toT: number): RecheckResult => {
    const inRange = rangeBars.all(symbol, fromT, toT) as Bar[];
    const before = (tailBars.all(symbol, fromT, CONTEXT_BARS) as Bar[]).reverse();
    const after = headBars.get(symbol, toT) as Bar | undefined;
    const all = [...before, ...inRange, ...(after ? [after] : [])];
    const found: Flag[] = findSpikes(all, before.length).filter((f) => f.t >= fromT && f.t < toT);
    // The last minute of each finished UTC day against the daily close of the day.
    const byDay = new Map<number, Bar[]>();
    for (const b of inRange) {
      const d = Math.floor(b.t / DAY) * DAY;
      (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(b);
    }
    for (const [dayStart, bars] of byDay) {
      if ((selectDay.get(symbol, dayStart) as { complete: number } | undefined)?.complete !== 1) continue;
      const daily = dailyOf.get(symbol, new Date(dayStart * 1000).toISOString().slice(0, 10)) as { c: number } | undefined;
      const flag = daily && compareToDaily(bars, daily.c, tolerance(symbol));
      if (flag) found.push(flag);
    }
    clearFlags.run(symbol, fromT, toT);
    for (const f of found) insertFlag.run(symbol, f.t, f.kind, f.detail);
    return { bars: inRange.length, spike: found.filter((f) => f.kind === "spike").length, daily: found.filter((f) => f.kind === "daily").length };
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

  const inflight = new Map<string, Promise<number>>();

  async function load(symbol: string, dayStartT: number): Promise<number> {
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
    // Bars that cannot be real are not stored, but noted; a minute sent twice or out of order is stored once and noted.
    const sound: Bar[] = [];
    const flags: Flag[] = findOrderProblems(finished);
    for (const b of finished) {
      const why = checkBar(b);
      if (why) flags.push({ t: b.t, kind: "struct", detail: why });
      else sound.push(b);
    }
    store(symbol, dayStartT, sound, now() >= dayEnd ? 1 : 0);
    for (const f of flags) insertFlag.run(symbol, f.t, f.kind, f.detail);
    // Spikes and the daily comparison need the neighbours; the day just stored is checked at once, the job checks again later.
    recheck(symbol, dayStartT, dayEnd);
    return sound.length;
  }

  /** One load per symbol and day at a time, however many callers ask. */
  function loadOnce(symbol: string, dayStartT: number): Promise<number> {
    const key = `${symbol}:${dayStartT}`;
    const running = inflight.get(key);
    if (running) return running;
    const p = load(symbol, dayStartT).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    async ensureDay(symbol, dayStartT) {
      const row = selectDay.get(symbol, dayStartT) as { complete: number } | undefined;
      if (row?.complete === 1) return;
      await loadOnce(symbol, dayStartT);
    },

    missingDays(symbols, fromDayT, toDayT, skip) {
      const out: MissingDay[] = [];
      for (let dayStart = toDayT - DAY; dayStart >= fromDayT; dayStart -= DAY) {
        for (const symbol of symbols) {
          if (skip?.(symbol, dayStart)) continue;
          const row = selectDay.get(symbol, dayStart) as { complete: number } | undefined;
          if (row?.complete === 1) continue;
          out.push({ symbol, dayStart, state: row ? "incomplete" : "never" });
        }
      }
      return out;
    },

    fetchDay: loadOnce,

    barsBetween(symbol, fromT, toT) {
      return db
        .prepare("select t, o, h, l, c, v from bars where symbol = ? and t >= ? and t < ? order by t")
        .all(symbol, fromT, toT) as Bar[];
    },

    lastCompleteBar(symbol, s, o) {
      if (o?.skipFlagged) {
        return db
          .prepare(
            "select t, o, h, l, c, v from bars where symbol = ? and t <= ? and not exists " +
              `(select 1 from bar_flags f where f.symbol = bars.symbol and f.t = bars.t and f.kind in (${BLOCKING_KINDS.map(() => "?").join(",")})) ` +
              "order by t desc limit 1",
          )
          .get(symbol, s - 60, ...BLOCKING_KINDS) as Bar | undefined;
      }
      return db
        .prepare("select t, o, h, l, c, v from bars where symbol = ? and t <= ? order by t desc limit 1")
        .get(symbol, s - 60) as Bar | undefined;
    },

    recheck: (symbol, fromT, toT) => recheck(symbol, fromT, toT),

    flagsBetween(symbol, fromT, toT, kinds) {
      const rows = prep(db, "select t, kind, detail from bar_flags where symbol = ? and t >= ? and t < ? order by t, kind").all(symbol, fromT, toT) as Flag[];
      return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
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
