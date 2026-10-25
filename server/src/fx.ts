import type { EcbSource } from "./data/ecb.js";
import { MarketDataError } from "./data/marketdata.js";
import type { Db } from "./db.js";
import { addDays } from "./domain/calendar.js";
import { describeError } from "./errors.js";
import { FX_SYMBOL } from "./config.js";

const DAY = 86400;
/** The longest hole between two stored days that is filled with the day before (a long weekend with a holiday, not more). */
const MAX_FILL_DAYS = 7;

/** Where a rate comes from. */
export type FxSourceKind = "yahoo-minute" | "ecb";

export interface FxRate {
  /** Units of `ccy` per 1 EUR. */
  rate: number;
  /** The day the rate belongs to; earlier than the day asked for when the last known rate is carried on. */
  day: string;
  source: FxSourceKind;
  /** The ECB published nothing that day (weekend, holiday): the rate of the day before stands in. */
  filled: boolean;
  /** The data ends before the day asked for: this is the last known rate. */
  stale: boolean;
  /** For the screen: "EZB, 16:00 Frankfurt", "Yahoo, Minute", "Kurs vom 23.10.2026". */
  label: string;
}

export interface FxStatus {
  latestDay: string | null;
  fetchedAt: number | null;
  /** Why the last fetch failed; null after a good one. */
  error: string | null;
  currencies: string[];
}

export interface FxRow {
  day: string;
  rate: number;
  filled: boolean;
}

export type FxUpdate = { ok: true; days: number } | { ok: false; reason: string };

export interface Fx {
  /** The rate of `ccy` on a UTC day. With `minute: false` the Yahoo minute series is not looked at. */
  rateOn(ccy: string, day: string, opts?: { minute?: boolean }): FxRate | undefined;
  rows(ccy: string, from?: string, to?: string): FxRow[];
  /** The newest stored day of one currency; undefined if there is none. */
  latest(ccy: string): { day: string; rate: number } | undefined;
  status(): FxStatus;
  /** Fetch from the ECB and store. Never throws; a failure leaves what is stored as it was. */
  update(): Promise<FxUpdate>;
  /**
   * The once-a-day job: fetches if nothing is stored or the ECB has published since the last good fetch.
   * #48 (Planer) calls this at 16:30 Berlin; until then app.ts looks at it every hour.
   */
  runDaily(): Promise<void>;
  /** The look at start-up: fetches only if nothing is stored or the newest day is older than two days. */
  runStartup(): Promise<void>;
}

const german = (day: string) => day.split("-").reverse().join(".");

/** UTC seconds of the most recent 16:30 Europe/Berlin at or before `nowS` (when the ECB publishes). */
export function lastPublication(nowS: number): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const offsetS = (utcS: number) => {
    const p = Object.fromEntries(fmt.formatToParts(utcS * 1000).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000 - utcS;
  };
  const at = (day: string) => {
    const guess = Date.parse(`${day}T16:30:00Z`) / 1000;
    return guess - offsetS(guess);
  };
  const berlinDay = (utcS: number) => new Date((utcS + offsetS(utcS)) * 1000).toISOString().slice(0, 10);
  const today = berlinDay(nowS);
  const t = at(today);
  return t <= nowS ? t : at(addDays(today, -1));
}

export function createFx(deps: { db: Db; source: EcbSource; now: () => number; log?: (text: string, ok: boolean) => void }): Fx {
  const { db, source, now } = deps;
  let error: string | null = null;
  let running: Promise<FxUpdate> | undefined;

  const exact = db.prepare("select day, rate, filled from fx_daily where ccy = ? and day <= ? order by day desc limit 1");
  const minuteRate = db.prepare("select c from bars where symbol = ? and t >= ? and t < ? order by t desc limit 1");
  const rangeRows = db.prepare("select day, rate, filled from fx_daily where ccy = ? and day >= ? and day <= ? order by day");
  const newest = db.prepare("select day, rate from fx_daily where ccy = ? order by day desc limit 1");
  const lastBefore = db.prepare("select day, rate from fx_daily where ccy = ? and day < ? order by day desc limit 1");
  const upsert = db.prepare(
    "insert into fx_daily (ccy, day, rate, filled) values (?, ?, ?, ?) " +
      "on conflict (ccy, day) do update set rate = excluded.rate, filled = excluded.filled",
  );
  const fetched = db.prepare("select fetched_at from fx_fetched where source = 'ecb'");
  const mark = db.prepare(
    "insert into fx_fetched (source, fetched_at) values ('ecb', ?) on conflict (source) do update set fetched_at = excluded.fetched_at",
  );
  const latestAny = db.prepare("select max(day) as d from fx_daily");
  const currencies = db.prepare("select distinct ccy from fx_daily order by ccy");

  function label(source: FxSourceKind, filled: boolean, stale: boolean, day: string): string {
    if (source === "yahoo-minute") return "Yahoo, Minute";
    if (stale) return `Kurs vom ${german(day)}`;
    return filled ? "EZB, 16:00 Frankfurt (aufgefüllt, an diesem Tag kein Kurs)" : "EZB, 16:00 Frankfurt";
  }

  const fetchedAt = () => (fetched.get() as { fetched_at: number } | undefined)?.fetched_at ?? null;
  const latestDay = () => (latestAny.get() as { d: string | null }).d;

  async function doUpdate(): Promise<FxUpdate> {
    try {
      // The whole history when nothing is stored or what is stored is older than the recent answer reaches (a short answer would leave a hole).
      const latest = latestDay();
      const stale = latest === null || latest < new Date((now() - 80 * 86_400) * 1000).toISOString().slice(0, 10);
      const rows = await source.fetch(stale ? "full" : "recent");
      // Per currency: the days the ECB gave, and every calendar day between them filled with the day before.
      const byCcy = new Map<string, Map<string, number>>();
      for (const r of rows) for (const [ccy, rate] of Object.entries(r.rates)) {
        if (!byCcy.has(ccy)) byCcy.set(ccy, new Map());
        byCcy.get(ccy)!.set(r.day, rate);
      }
      let written = 0;
      db.transaction(() => {
        for (const [ccy, real] of byCcy) {
          const days = [...real.keys()].sort();
          // Start from what is stored, so a gap between it and this answer is filled too.
          // A stored rate older than a week is not carried over the hole to this answer: a rate "filled" for months would pass for
          // a weekend. The days before the answer then stay without a rate, which `rateOn` reports as stale.
          const found = lastBefore.get(ccy, days[0]) as { day: string; rate: number } | undefined;
          const before = found && (Date.parse(`${days[0]}T00:00:00Z`) - Date.parse(`${found.day}T00:00:00Z`)) / 86_400_000 <= MAX_FILL_DAYS ? found : undefined;
          let carry = before?.rate;
          let day = before ? addDays(before.day, 1) : days[0];
          const last = days[days.length - 1];
          for (; day <= last; day = addDays(day, 1)) {
            const rate = real.get(day);
            if (rate !== undefined) {
              carry = rate;
              upsert.run(ccy, day, rate, 0);
            } else if (carry !== undefined) {
              upsert.run(ccy, day, carry, 1);
            }
            written++;
          }
        }
        mark.run(Math.floor(now()));
      })();
      error = null;
      deps.log?.(`Wechselkurse: ${written} Tageswerte von der EZB, neuester Tag ${latestDay()}`, true);
      return { ok: true, days: written };
    } catch (err) {
      error = describeError(err).replace("Die Kursquelle", "Die EZB");
      deps.log?.(`Wechselkurse: Abruf bei der EZB fehlgeschlagen: ${error}`, false);
      return { ok: false, reason: error };
    }
  }

  const update = () => (running ??= doUpdate().finally(() => (running = undefined)));

  return {
    rateOn(ccy, day, opts = {}) {
      if (ccy === "EUR") return { rate: 1, day, source: "ecb", filled: false, stale: false, label: "Euro" };
      if (ccy === "USD" && opts.minute !== false) {
        const start = Date.parse(`${day}T00:00:00Z`) / 1000;
        const m = minuteRate.get(FX_SYMBOL, start, start + DAY) as { c: number } | undefined;
        if (m) return { rate: m.c, day, source: "yahoo-minute", filled: false, stale: false, label: label("yahoo-minute", false, false, day) };
      }
      const row = exact.get(ccy, day) as { day: string; rate: number; filled: number } | undefined;
      if (!row) return undefined;
      const stale = row.day < day;
      return { rate: row.rate, day: row.day, source: "ecb", filled: row.filled === 1, stale, label: label("ecb", row.filled === 1, stale, row.day) };
    },
    rows: (ccy, from = "0000-01-01", to = "9999-12-31") =>
      (rangeRows.all(ccy, from, to) as { day: string; rate: number; filled: number }[]).map((r) => ({ day: r.day, rate: r.rate, filled: r.filled === 1 })),
    latest: (ccy) => newest.get(ccy) as { day: string; rate: number } | undefined,
    status: () => ({
      latestDay: latestDay(),
      fetchedAt: fetchedAt(),
      error,
      currencies: (currencies.all() as { ccy: string }[]).map((r) => r.ccy),
    }),
    update,
    async runDaily() {
      const at = fetchedAt();
      // Also when what is stored is old although a fetch was marked recent: a fetch that wrote only old days (the ECB's broken
      // history file, 2026-10-25) must not keep the job from fetching again.
      const latest = latestDay();
      const today = new Date(now() * 1000).toISOString().slice(0, 10);
      if (latest === null || at === null || at < lastPublication(now()) || latest < addDays(today, -6)) await update();
    },
    async runStartup() {
      const latest = latestDay();
      const today = new Date(now() * 1000).toISOString().slice(0, 10);
      if (latest === null || latest < addDays(today, -2)) await update();
    },
  };
}
