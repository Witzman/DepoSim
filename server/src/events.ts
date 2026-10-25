import type { Db } from "./db.js";
import { MarketDataError, type DailyData } from "./data/marketdata.js";

/** Dividends and splits of the instruments, from the same daily source as the long-term comparison. */
export interface Events {
  /** Fetches the events of a symbol unless they are fresh. Never throws: a failure leaves the symbol to be tried again. */
  ensure(symbol: string): Promise<void>;
  dividends(symbol: string, fromDay: string, toDay: string): { exDay: string; amount: number }[];
  splits(symbol: string, fromDay: string, toDay: string): { day: string; numerator: number; denominator: number }[];
}

/** Events are asked for again after this long. */
const FRESH_S = 12 * 3600;
/** The first day Yahoo events are asked for; the minute archive starts later than this. */
const FROM_DAY = "2019-11-01";

export function createEvents(deps: { db: Db; source: DailyData; now: () => number; log?: (text: string) => void }): Events {
  const { db, source, now } = deps;
  const fetched = db.prepare("select fetched_at from events_fetched where symbol = ?");
  const mark = db.prepare("insert or replace into events_fetched (symbol, fetched_at) values (?, ?)");
  const insertDiv = db.prepare("insert or replace into dividends (symbol, ex_day, amount) values (?, ?, ?)");
  const insertSplit = db.prepare("insert or replace into splits (symbol, day, numerator, denominator) values (?, ?, ?, ?)");
  const selectDiv = db.prepare("select ex_day as exDay, amount from dividends where symbol = ? and ex_day >= ? and ex_day <= ? order by ex_day");
  const selectSplit = db.prepare("select day, numerator, denominator from splits where symbol = ? and day >= ? and day <= ? order by day");
  const inflight = new Map<string, Promise<void>>();

  async function fetchOne(symbol: string): Promise<void> {
    const row = fetched.get(symbol) as { fetched_at: number } | undefined;
    if (row && now() - row.fetched_at < FRESH_S) return;
    try {
      const s = await source.daily(symbol, Math.floor(Date.parse(`${FROM_DAY}T00:00:00Z`) / 1000), Math.floor(now()));
      db.transaction(() => {
        for (const d of s.dividends) insertDiv.run(symbol, d.exDay, d.amount);
        for (const sp of s.splits) {
          if (sp.numerator > 0 && sp.denominator > 0) insertSplit.run(symbol, sp.day, sp.numerator, sp.denominator);
        }
        mark.run(symbol, Math.floor(now()));
      })();
    } catch (err) {
      // A symbol without daily data (an index, a new listing) is not an error; anything else is tried again next time.
      if (err instanceof MarketDataError && err.kind === "no_data") mark.run(symbol, Math.floor(now()));
      else deps.log?.(`Ereignisse für ${symbol} nicht geladen: ${(err as Error).message}`);
    }
  }

  return {
    ensure(symbol) {
      let p = inflight.get(symbol);
      if (!p) {
        p = fetchOne(symbol).finally(() => inflight.delete(symbol));
        inflight.set(symbol, p);
      }
      return p;
    },
    dividends: (symbol, fromDay, toDay) => selectDiv.all(symbol, fromDay, toDay) as { exDay: string; amount: number }[],
    splits: (symbol, fromDay, toDay) => selectSplit.all(symbol, fromDay, toDay) as { day: string; numerator: number; denominator: number }[],
  };
}
