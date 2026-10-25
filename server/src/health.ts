import { FX_SYMBOL, VENUES, type Instrument, type VenueInfo } from "./config.js";
import type { BackupService } from "./backup.js";
import type { SourceStats, SourceSummary } from "./data/instrumented.js";
import type { Db } from "./db.js";
import { sessionFor } from "./domain/venues.js";
import type { InstrumentRegistry } from "./instruments.js";
import { REACH_DAYS } from "./backfill.js";
import { type Jobs, zonedToUtc } from "./jobs.js";

const DAY = 86400;
const MINUTE = 60;

/** The collection counts as failed when its last success is older than this. */
export const STALE_COLLECTION_S = 2 * DAY;
/** Above this share of the expected bars a day is not "thin". Yahoo's own answer for thin ETFs was about a fifth (EXS1.DE 108 of 510). */
const THIN_BELOW = 0.5;
const MAX_GAP_LIST = 200;

export type CellState = "complete" | "partial" | "empty" | "never" | "closed";

export interface Cell {
  day: string;
  state: CellState;
  bars: number;
  /** Minutes the market is open that day; null where no hours are known. */
  expected: number | null;
  /** A finished day with far fewer bars than the hours allow. Only a hint, never an error. */
  thin: boolean;
  /** The day is still running, so a missing bar is not a gap yet. */
  today: boolean;
  /** Why the market is shut ("Wochenende", "Feiertag: Karfreitag"). */
  reason?: string;
}

export interface CoverageRow {
  symbol: string;
  name: string;
  venue: string;
  kind: "EQUITY" | "ETF" | "FX";
  cells: Cell[];
}

export interface Coverage {
  days: string[];
  reachDays: number;
  rows: CoverageRow[];
  /** Cells of finished trading days that are never loaded, cut off or empty. */
  gapCells: number;
}

export interface GapRun {
  /** UTC seconds, [from, to). */
  from: number;
  to: number;
  minutes: number;
}

export interface GapReport {
  symbol: string;
  day: string;
  /** False: the market is shut that day, nothing is expected. */
  open: boolean;
  reason?: string;
  windowFrom: number | null;
  windowTo: number | null;
  expected: number;
  bars: number;
  missingMinutes: number;
  gaps: GapRun[];
  truncated: boolean;
  hint: string;
}

export type Level = "green" | "yellow" | "red";
const RANK: Record<Level, number> = { green: 0, yellow: 1, red: 2 };

export interface Reason {
  level: Level | "info";
  text: string;
}

export interface DataStatus {
  level: Level;
  reasons: Reason[];
  /** UTC seconds of the last collection run that loaded or found its day; null if none. */
  lastCollectionAt: number | null;
  gapCells: number;
  rateLimited24h: number;
}

export interface ArchiveInfo {
  rows: { bars: number; dailyBars: number; fetchedDays: number };
  fileBytes: number;
  /** Bars by calendar week of the bar (not of the fetch), newest last, and what they weigh on average. */
  weeks: { weekStart: string; bars: number; estimatedBytes: number }[];
  bytesPerBar: number | null;
  lastBackupAt: number | null;
  backupEnabled: boolean;
}

export interface Health {
  coverage(days?: number): Coverage;
  gaps(symbol: string, day: string): GapReport | null;
  sources(): SourceSummary[];
  archive(): ArchiveInfo;
  status(): DataStatus;
  /** Writes an entry to the job log when the light has changed since the last entry. Returns the new level if it wrote one. */
  checkAlarm(): Level | null;
}

const dayName = (dayStart: number) => new Date(dayStart * 1000).toISOString().slice(0, 10);
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const LEVEL_NUM: Record<Level, number> = { green: 0, yellow: 1, red: 2 };
const LEVEL_WORD: Record<Level, string> = { green: "grün", yellow: "gelb", red: "rot" };

export function createHealth(deps: {
  db: Db;
  instruments: InstrumentRegistry;
  stats: SourceStats;
  jobs: Jobs;
  backup: BackupService;
  now: () => number;
}): Health {
  const { db, instruments, stats, jobs, backup, now } = deps;

  const venueOf = (symbol: string): VenueInfo | undefined => {
    const inst = instruments.list().find((i) => i.symbol === symbol);
    return inst && VENUES.find((v) => v.id === inst.venue);
  };

  /** What a day looks like at the market of `symbol`: shut (with the reason), or open for this many minutes. */
  function dayInfo(symbol: string, day: string): { closed: string | null; expected: number | null } {
    if (symbol === FX_SYMBOL) {
      // The rate runs round the clock from Sunday evening to Friday; Yahoo has nothing on Saturday.
      return new Date(`${day}T00:00:00Z`).getUTCDay() === 6 ? { closed: "Wochenende", expected: null } : { closed: null, expected: 1440 };
    }
    const venue = venueOf(symbol);
    if (!venue) return { closed: null, expected: null };
    const s = sessionFor(venue, day);
    if (!s.trading) return { closed: s.reason ?? "geschlossen", expected: null };
    return { closed: null, expected: minutesOf(s.closes) - minutesOf(s.opens) };
  }

  const symbolsShown = (): { symbol: string; name: string; venue: string; kind: CoverageRow["kind"] }[] => [
    ...instruments.list().map((i: Instrument) => ({ symbol: i.symbol, name: i.name, venue: i.venue, kind: i.kind ?? ("EQUITY" as const) })),
    { symbol: FX_SYMBOL, name: "Wechselkurs EUR/USD", venue: "FX", kind: "FX" as const },
  ];

  const fetched = db.prepare("select symbol, day_start, complete from fetched_days where day_start >= ? and day_start < ?");

  /** The cells of every symbol for the given days; `barsOf` says how many bars a symbol has on a day. */
  function cells(days: number[], barsOf: (symbol: string, dayStart: number) => number, today: number) {
    const done = new Map<string, number>();
    for (const r of fetched.all(days[0], days[days.length - 1] + DAY) as { symbol: string; day_start: number; complete: number }[]) {
      done.set(`${r.symbol}|${r.day_start}`, r.complete);
    }
    return symbolsShown().map((s) => ({
      ...s,
      cells: days.map((dayStart): Cell => {
        const day = dayName(dayStart);
        const info = dayInfo(s.symbol, day);
        const isToday = dayStart >= today;
        const bars = barsOf(s.symbol, dayStart);
        const base = { day, bars, expected: info.expected, today: isToday };
        if (info.closed) return { ...base, state: "closed", thin: false, reason: info.closed };
        const complete = done.get(`${s.symbol}|${dayStart}`);
        const state: CellState = complete === undefined ? (bars > 0 ? "partial" : "never")
          : complete === 1 ? (bars > 0 ? "complete" : "empty") : "partial";
        const thin = state === "complete" && info.expected !== null && bars < info.expected * THIN_BELOW;
        return { ...base, state, thin };
      }),
    }));
  }

  const isGap = (c: Cell) => !c.today && (c.state === "never" || c.state === "partial" || c.state === "empty");

  function dayStarts(days: number): { list: number[]; today: number } {
    const today = Math.floor(now() / DAY) * DAY;
    return { list: Array.from({ length: days }, (_, i) => today - (days - 1 - i) * DAY), today };
  }

  const countByDay = db.prepare(
    "select symbol, cast(t / 86400 as integer) * 86400 as d, count(*) as n from bars where t >= ? and t < ? group by symbol, d",
  );
  const anyBar = db.prepare("select 1 as x from bars where symbol = ? and t >= ? and t < ? limit 1");

  function gapCells(): number {
    const { list, today } = dayStarts(REACH_DAYS);
    const rows = cells(list, (symbol, d) => (anyBar.get(symbol, d, d + DAY) ? 1 : 0), today);
    return rows.reduce((a, r) => a + r.cells.filter(isGap).length, 0);
  }

  /** Collection runs that count as a success: finished "ok", or "partial" that loaded something. */
  function collectionState(): { enabled: boolean; lastOk: number | null; firstRun: number | null; failedJobs: string[] } {
    const active = jobs.list().filter((j) => j.name.startsWith("sammlung-") && j.enabled);
    const rows = db.prepare("select started_at, finished_at, status, counts from job_runs where job like 'sammlung-%' and status != 'running'").all() as
      { started_at: number; finished_at: number | null; status: string; counts: string | null }[];
    let lastOk: number | null = null;
    for (const r of rows) {
      const loaded = r.counts ? (JSON.parse(r.counts).loaded as number | undefined) ?? 0 : 0;
      if (r.status === "ok" || (r.status === "partial" && loaded > 0)) lastOk = Math.max(lastOk ?? 0, r.finished_at ?? r.started_at);
    }
    const first = db.prepare("select min(started_at) as t from job_runs where job like 'sammlung-%'").get() as { t: number | null };
    return {
      enabled: jobs.enabled && active.length > 0, lastOk, firstRun: first.t,
      failedJobs: jobs.list().filter((j) => j.enabled && j.lastRun?.status === "error").map((j) => j.label),
    };
  }

  function status(): DataStatus {
    const reasons: Reason[] = [];
    const t = now();
    const col = collectionState();
    if (!col.enabled) {
      reasons.push({ level: "info", text: "Die automatische Sammlung ist aus (JOBS=off oder beide Sammelaufträge abgeschaltet)." });
    } else if (col.lastOk === null && col.firstRun === null) {
      reasons.push({ level: "yellow", text: "Die Sammlung ist noch nicht gelaufen." });
    } else {
      const ref = col.lastOk ?? col.firstRun!;
      if (t - ref > STALE_COLLECTION_S) {
        reasons.push({
          level: "red",
          text: col.lastOk === null
            ? "Die Sammlung ist seit mehr als 2 Tagen nie gelungen."
            : `Der letzte erfolgreiche Sammellauf ist älter als 2 Tage (${new Date(col.lastOk * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC).`,
        });
      }
    }
    const limited = stats.summary().reduce((a, s) => a + s.counts["429"], 0);
    if (limited > 0) reasons.push({ level: "yellow", text: `Die Kursquelle hat in den letzten 24 Stunden ${limited}-mal mit 429 abgelehnt.` });
    const gaps = gapCells();
    if (gaps > 0) {
      reasons.push({ level: "yellow", text: `${gaps} Handelstage der letzten ${REACH_DAYS} Tage sind nicht vollständig geladen (siehe Raster).` });
    }
    for (const label of col.failedJobs) reasons.push({ level: "yellow", text: `Der letzte Lauf „${label}“ ist fehlgeschlagen.` });

    const level = reasons.reduce<Level>((a, r) => (r.level !== "info" && RANK[r.level] > RANK[a] ? r.level : a), "green");
    return { level, reasons, lastCollectionAt: col.lastOk, gapCells: gaps, rateLimited24h: limited };
  }

  return {
    coverage(days = 30) {
      const { list, today } = dayStarts(days);
      const counts = new Map<string, number>();
      for (const r of countByDay.all(list[0], list[list.length - 1] + DAY) as { symbol: string; d: number; n: number }[]) {
        counts.set(`${r.symbol}|${r.d}`, r.n);
      }
      const rows = cells(list, (symbol, d) => counts.get(`${symbol}|${d}`) ?? 0, today);
      return {
        days: list.map(dayName), reachDays: REACH_DAYS, rows,
        gapCells: rows.reduce((a, r) => a + r.cells.filter(isGap).length, 0),
      };
    },

    gaps(symbol, day) {
      const shown = symbolsShown().find((s) => s.symbol === symbol);
      if (!shown || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null;
      const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
      const times = (db.prepare("select t from bars where symbol = ? and t >= ? and t < ? order by t").all(symbol, dayStart, dayStart + DAY) as { t: number }[]).map((r) => r.t);
      const have = new Set(times);
      const info = dayInfo(symbol, day);
      const thinEtf = shown.kind === "ETF" && shown.venue === "XETRA";
      const hint = thinEtf
        ? "Bei Xetra-ETFs ist es normal, dass Minuten ohne Balken sind (kein Handel in der Minute). Das ist keine Störung."
        : "Eine Minute ohne Balken heißt: in der Minute wurde nicht gehandelt, oder die Quelle hat keinen Balken geliefert.";
      const empty = { symbol, day, windowFrom: null, windowTo: null, expected: 0, bars: times.length, missingMinutes: 0, gaps: [], truncated: false, hint };
      if (info.closed) return { ...empty, open: false, reason: info.closed };

      let from: number | null;
      let to: number | null;
      const venue = venueOf(symbol);
      if (symbol !== FX_SYMBOL && venue) {
        const s = sessionFor(venue, day);
        from = zonedToUtc(venue.timeZone, day, s.opens);
        to = zonedToUtc(venue.timeZone, day, s.closes);
      } else {
        // The rate has no hours: from its first to its last bar of the day.
        from = times[0] ?? null;
        to = times.length ? times[times.length - 1] + MINUTE : null;
      }
      if (from === null || to === null) return { ...empty, open: true };
      to = Math.min(to, Math.floor(now() / MINUTE) * MINUTE); // the minutes that are not over are not missing
      if (to <= from) return { ...empty, open: true, windowFrom: from, windowTo: to };

      const gaps: GapRun[] = [];
      let runFrom: number | null = null;
      let missing = 0;
      let inWindow = 0;
      for (let t = from; t <= to; t += MINUTE) {
        const miss = t < to && !have.has(t);
        if (t < to && have.has(t)) inWindow++;
        if (miss) {
          missing++;
          runFrom ??= t;
        } else if (runFrom !== null) {
          gaps.push({ from: runFrom, to: t, minutes: (t - runFrom) / MINUTE });
          runFrom = null;
        }
      }
      return {
        symbol, day, open: true, windowFrom: from, windowTo: to, expected: (to - from) / MINUTE, bars: inWindow,
        missingMinutes: missing, gaps: gaps.slice(0, MAX_GAP_LIST), truncated: gaps.length > MAX_GAP_LIST, hint,
      };
    },

    sources: () => stats.summary(),

    archive() {
      const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      const rows = { bars: n("select count(*) as n from bars"), dailyBars: n("select count(*) as n from daily_bars"), fetchedDays: n("select count(*) as n from fetched_days") };
      const fileBytes = (db.pragma("page_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number);
      const bytesPerBar = rows.bars > 0 ? fileBytes / rows.bars : null;
      const WEEK = 7 * DAY;
      // 1970-01-01 was a Thursday, so `t / WEEK` weeks start on Thursday; the first Monday is day 4.
      const from = Math.floor((now() - 8 * WEEK) / WEEK) * WEEK;
      const perWeek = db.prepare("select cast((t - 345600) / 604800 as integer) as w, count(*) as n from bars where t >= ? group by w order by w").all(from) as { w: number; n: number }[];
      const backupStatus = backup.status();
      return {
        rows, fileBytes,
        weeks: perWeek.slice(-8).map((r) => ({ weekStart: dayName(r.w * WEEK + 345600), bars: r.n, estimatedBytes: Math.round(r.n * (bytesPerBar ?? 0)) })),
        bytesPerBar: bytesPerBar === null ? null : Math.round(bytesPerBar),
        lastBackupAt: backupStatus.lastAt, backupEnabled: backupStatus.enabled,
      };
    },

    status,

    checkAlarm() {
      const s = status();
      const last = db.prepare("select counts from job_runs where job = 'ampel' order by id desc limit 1").get() as { counts: string | null } | undefined;
      const before = last?.counts ? (JSON.parse(last.counts).level as number) : 0;
      if (before === LEVEL_NUM[s.level]) return null;
      const t = Math.floor(now());
      const text = s.reasons.filter((r) => r.level !== "info").map((r) => r.text).join(" ") || "Alles in Ordnung.";
      const runStatus = s.level === "green" ? "ok" : s.level === "yellow" ? "partial" : "error";
      db.prepare("insert into job_runs (job, trigger, slot, started_at, finished_at, status, message, counts) values ('ampel', 'plan', null, ?, ?, ?, ?, ?)")
        .run(t, t, runStatus, `Datenampel ${LEVEL_WORD[s.level]}. ${text}`, JSON.stringify({ level: LEVEL_NUM[s.level] }));
      return s.level;
    },
  };
}
