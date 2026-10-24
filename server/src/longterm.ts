import { type DailyData, MarketDataError } from "./data/marketdata.js";
import type { Db } from "./db.js";
import { DEFAULT_FEES, type FeeConfig } from "./domain/fees.js";
import { type DailyBar, type LongtermResult, simulateLongterm } from "./domain/longterm.js";
import { describeError } from "./errors.js";

const DAY = 86400;

/** The comparison starts here: first buy at the open of the first trading day on or after it. */
export const LONGTERM_START_DAY = "2019-11-01";
/** 40,000 EUR in cent. */
export const LONGTERM_START_CASH = 4_000_000;

export interface LongtermDepot {
  key: string;
  /** The index the owner asked for. */
  index: string;
  symbol: string;
  etf: string;
}

/**
 * Distributing ETFs quoted in EUR on Xetra, each with daily data and dividend events since 2019-11
 * (measured 2026-10-24). `VWRL.DE` does not exist on Yahoo; its Xetra line is `VGWL.DE`.
 * `SPYY.DE` is MSCI ACWI, `EUNL.DE` and `IWDA.AS` accumulate, so none of them would do.
 */
export const LONGTERM_DEPOTS: LongtermDepot[] = [
  { key: "ftse", index: "FTSE All-World", symbol: "VGWL.DE", etf: "Vanguard FTSE All-World UCITS ETF (ausschüttend)" },
  { key: "sp500", index: "S&P 500", symbol: "VUSA.DE", etf: "Vanguard S&P 500 UCITS ETF (ausschüttend)" },
  { key: "msci", index: "MSCI World", symbol: "IQQW.DE", etf: "iShares MSCI World UCITS ETF USD (Dist)" },
];

export interface LongtermDepotResult extends LongtermDepot {
  totals: Omit<LongtermResult, "points">;
  /** [day, value in cent] per trading day, for the chart. */
  curve: [string, number][];
  dividendEvents: number;
}

export interface LongtermReady {
  ready: true;
  startDay: string;
  startCash: number;
  fees: FeeConfig;
  depots: LongtermDepotResult[];
}

export interface LongtermNotReady {
  ready: false;
  missing: { symbol: string; reason: string }[];
}

export type LongtermItemStatus = "loaded" | "current" | "error" | "skipped";

export interface LongtermJob {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  done: number;
  total: number;
  items: { symbol: string; status: LongtermItemStatus; label: string; bars?: number; dividends?: number; reason?: string }[];
  stoppedByRateLimit: boolean;
  error?: string;
}

const LABELS: Record<LongtermItemStatus, string> = {
  loaded: "geladen", current: "aktuell", error: "Fehler", skipped: "übersprungen",
};

export type LongtermStart = { ok: true; job: LongtermJob } | { ok: false; reason: string };

export interface Longterm {
  compute(): LongtermReady | LongtermNotReady;
  start(): LongtermStart;
  status(): LongtermJob;
  settled(): Promise<void>;
}

const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

/** The last weekday that is over (UTC). Holidays are not known, see `isStale`. */
export function lastFinishedWeekday(nowS: number): string {
  let t = Math.floor(nowS / DAY) * DAY - DAY;
  while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t -= DAY;
  return new Date(t * 1000).toISOString().slice(0, 10);
}

export function createLongterm(deps: {
  db: Db;
  source: DailyData;
  now: () => number;
  minGapMs?: number;
  fees?: FeeConfig;
}): Longterm {
  const { db, source, now } = deps;
  const minGapMs = deps.minGapMs ?? 500;
  const fees = deps.fees ?? DEFAULT_FEES;

  const fetched = db.prepare("select fetched_at, last_day, splits from daily_fetched where symbol = ?");
  const insertBar = db.prepare("insert or replace into daily_bars (symbol, day, o, h, l, c, v) values (?, ?, ?, ?, ?, ?, ?)");
  const insertDiv = db.prepare("insert or replace into dividends (symbol, ex_day, amount) values (?, ?, ?)");
  const mark = db.prepare(
    "insert into daily_fetched (symbol, fetched_at, last_day, splits) values (?, ?, ?, ?) " +
      "on conflict (symbol) do update set fetched_at = excluded.fetched_at, last_day = excluded.last_day, splits = excluded.splits",
  );
  const selectBars = db.prepare("select day, o, c from daily_bars where symbol = ? order by day");
  const selectDivs = db.prepare("select ex_day as exDay, amount from dividends where symbol = ? order by ex_day");

  /**
   * Fetch once per symbol. Stale only when the newest stored day is older than the last finished
   * weekday AND the data was fetched before that weekday was over (otherwise a holiday would make
   * every click fetch again).
   */
  function isStale(symbol: string): boolean {
    const row = fetched.get(symbol) as { fetched_at: number; last_day: string | null } | undefined;
    if (!row) return true;
    const finished = lastFinishedWeekday(now());
    if (row.last_day !== null && row.last_day >= finished) return false;
    return row.fetched_at < dayStart(finished) + DAY;
  }

  let job: LongtermJob = { running: false, startedAt: null, finishedAt: null, done: 0, total: 0, items: [], stoppedByRateLimit: false };
  let current: Promise<void> = Promise.resolve();
  let running = false;

  async function work(mine: LongtermJob, symbols: string[]) {
    try {
      let first = true;
      for (const symbol of symbols) {
        const add = (status: LongtermItemStatus, extra: { bars?: number; dividends?: number; reason?: string } = {}) =>
          mine.items.push({ symbol, status, label: LABELS[status], ...extra });
        if (mine.stoppedByRateLimit) {
          add("skipped", { reason: "Yahoo hat mit 429 abgelehnt; der Rest wurde nicht versucht." });
        } else if (!isStale(symbol)) {
          add("current");
        } else {
          if (!first && minGapMs > 0) await new Promise((r) => setTimeout(r, minGapMs));
          first = false;
          try {
            const s = await source.daily(symbol, dayStart(LONGTERM_START_DAY), Math.floor(now()));
            db.transaction(() => {
              for (const b of s.bars) insertBar.run(symbol, b.day, b.o, b.h, b.l, b.c, b.v);
              for (const d of s.dividends) insertDiv.run(symbol, d.exDay, d.amount);
              mark.run(symbol, Math.floor(now()), s.bars.length ? s.bars[s.bars.length - 1].day : null, s.splits.length);
            })();
            add("loaded", { bars: s.bars.length, dividends: s.dividends.length });
          } catch (err) {
            if (err instanceof MarketDataError && err.kind === "rate_limited") mine.stoppedByRateLimit = true;
            add("error", { reason: describeError(err) });
          }
        }
        mine.done = mine.items.length;
      }
    } catch (err) {
      mine.error = describeError(err);
    } finally {
      mine.running = false;
      mine.finishedAt = Math.floor(now());
      running = false;
    }
  }

  return {
    start() {
      if (running) return { ok: false, reason: "Es läuft bereits ein Laden der Langzeitdaten." };
      running = true;
      const symbols = LONGTERM_DEPOTS.map((d) => d.symbol);
      job = { running: true, startedAt: Math.floor(now()), finishedAt: null, done: 0, total: symbols.length, items: [], stoppedByRateLimit: false };
      const mine = job;
      current = work(mine, symbols);
      return { ok: true, job: { ...mine, items: [...mine.items] } };
    },
    status: () => ({ ...job, items: [...job.items] }),
    settled: () => current,

    compute() {
      const missing: LongtermNotReady["missing"] = [];
      const depots: LongtermDepotResult[] = [];
      for (const d of LONGTERM_DEPOTS) {
        const row = fetched.get(d.symbol) as { splits: number } | undefined;
        if (!row) {
          missing.push({ symbol: d.symbol, reason: "noch nicht geladen" });
          continue;
        }
        if (row.splits > 0) {
          missing.push({ symbol: d.symbol, reason: "enthält einen Aktiensplit, den die Rechnung nicht abbildet" });
          continue;
        }
        const bars = selectBars.all(d.symbol) as DailyBar[];
        const dividends = selectDivs.all(d.symbol) as { exDay: string; amount: number }[];
        const result = simulateLongterm({ bars, dividends, startDay: LONGTERM_START_DAY, startCash: LONGTERM_START_CASH, fees });
        const { points, ...totals } = result;
        depots.push({ ...d, totals, curve: points.map((p) => [p.day, p.value]), dividendEvents: dividends.length });
      }
      if (missing.length > 0) return { ready: false, missing };
      return { ready: true, startDay: LONGTERM_START_DAY, startCash: LONGTERM_START_CASH, fees, depots };
    },
  };
}
