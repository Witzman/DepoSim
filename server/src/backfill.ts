import { FX_SYMBOL, VENUES } from "./config.js";
import type { Archive } from "./data/archive.js";
import { MarketDataError } from "./data/marketdata.js";
import { sessionFor, venueOpenAt } from "./domain/venues.js";
import { describeError } from "./errors.js";
import type { InstrumentRegistry } from "./instruments.js";
import type { SessionService } from "./session.js";
import type { Store } from "./store.js";

const DAY = 86400;

/**
 * How many days back Yahoo serves minute bars. Measured 2026-10-24: 29 days back answered 200,
 * 31 days back answered 422 "The requested range must be within the last 30 days". 29 keeps a margin.
 */
export const REACH_DAYS = 29;

/** How far back a backfill looks when the person does not say. NOT MEASURED: a guess that seems enough for a week of play. */
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 60;

export type BackfillStatus = "loaded" | "empty" | "error" | "skipped" | "out_of_range";

const LABELS: Record<BackfillStatus, string> = {
  loaded: "geladen",
  empty: "leer",
  error: "Fehler",
  skipped: "übersprungen",
  out_of_range: "außerhalb der Reichweite",
};

export interface MissingItem {
  symbol: string;
  /** "YYYY-MM-DD", UTC. */
  day: string;
  dayStart: number;
  state: "never" | "incomplete";
  inReach: boolean;
}

export interface MissingList {
  days: number;
  /** True while the number of days is the unmeasured default. */
  daysIsAssumption: boolean;
  reachDays: number;
  /** The German reason a backfill would be refused right now, or null. */
  blocked: string | null;
  items: MissingItem[];
}

export interface ReportItem {
  symbol: string;
  day: string;
  dayStart: number;
  status: BackfillStatus;
  label: string;
  bars?: number;
  reason?: string;
}

export interface BackfillReport {
  days: number;
  daysIsAssumption: boolean;
  stoppedByRateLimit: boolean;
  /** Set when the run was stopped from outside (a live simulation started, shutdown); the rest is "skipped". */
  interrupted?: string;
  counts: { loaded: number; empty: number; error: number; skipped: number; outOfRange: number };
  items: ReportItem[];
}

/** The current or last backfill. Only the last report is kept, in memory; a restart forgets it. */
export interface BackfillJob {
  running: boolean;
  /** UTC seconds; null while no backfill has run since the start. */
  startedAt: number | null;
  finishedAt: number | null;
  /** Items tried so far, and items planned. */
  done: number;
  total: number;
  report: BackfillReport | null;
  /** Set only when the run broke off on an unexpected error. */
  error?: string;
}

/** What a run is given beyond the list: the scheduler spaces its calls out and can stop a run. */
export interface ExecuteHooks {
  /** Pause before every call after the first, in ms. */
  gapMs?: number;
  /** A reason to stop before the next call, or null. */
  shouldStop?: () => string | null;
  onProgress?: (done: number) => void;
}

export type BackfillStart = { ok: true; job: BackfillJob } | { ok: false; reason: string };

const dayName = (dayStart: number) => new Date(dayStart * 1000).toISOString().slice(0, 10);

export interface PlanItem {
  symbol: string;
  dayStart: number;
  state: "never" | "incomplete";
  inReach: boolean;
}

export interface Backfill {
  missing(days?: number): MissingList;
  /** Starts a background job and returns at once with its state, or says why it is refused. */
  start(days?: number): BackfillStart;
  status(): BackfillJob;
  /** The finished days of the last `days` days that are missing or incomplete, newest first (no `blocked` check). */
  planFor(days: number): PlanItem[];
  /** Fetches the items one after the other. Shared by the button and the scheduler; never throws on a failed item. */
  execute(items: PlanItem[], days: number, hooks?: ExecuteHooks): Promise<BackfillReport>;
  /** Resolves when the job that is running now has finished (for tests and shutdown). */
  settled(): Promise<void>;
}

export function createBackfill(deps: {
  archive: Archive;
  store: Store;
  session: SessionService;
  instruments: InstrumentRegistry;
  now: () => number;
}): Backfill {
  const { archive, store, session, instruments, now } = deps;
  let running = false;
  let job: BackfillJob = { running: false, startedAt: null, finishedAt: null, done: 0, total: 0, report: null };
  let current: Promise<void> = Promise.resolve();

  function blocked(): string | null {
    const t = now();
    // Markets in use are those with an instrument on the list; only markets with a source can have one.
    const used = new Set<string>(instruments.list().map((i) => i.venue));
    for (const v of VENUES) {
      if (used.has(v.id) && venueOpenAt(v, t)) {
        return `${v.name} ist gerade geöffnet. Nachladen ist nur bei geschlossenen Märkten möglich.`;
      }
    }
    if (store.listSimulations().some((s) => s.live && s.endedAt === null && session.isRunning(s.id))) {
      return "Eine Live-Simulation läuft. Bitte zuerst pausieren oder beenden.";
    }
    if (running) return "Es läuft bereits ein Nachladen.";
    return null;
  }

  /** True on a day the symbol's market is shut (weekend, holiday): Yahoo has nothing there, so nothing is asked. The exchange rate runs round the clock. */
  function noTrading(symbol: string, dayStart: number): boolean {
    const inst = instruments.list().find((i) => i.symbol === symbol);
    const venue = inst && VENUES.find((v) => v.id === inst.venue);
    return venue !== undefined && !sessionFor(venue, dayName(dayStart)).trading;
  }

  /** Finished UTC days only: the day that is still running is not "missing", it is not over. */
  function plan(days: number) {
    const today = Math.floor(now() / DAY) * DAY;
    const symbols = [...instruments.list().map((i) => i.symbol), FX_SYMBOL];
    const reachFrom = today - REACH_DAYS * DAY;
    return archive.missingDays(symbols, today - days * DAY, today, noTrading).map((m) => ({ ...m, inReach: m.dayStart >= reachFrom }));
  }

  return {
    missing(days = DEFAULT_DAYS) {
      return {
        days,
        daysIsAssumption: days === DEFAULT_DAYS,
        reachDays: REACH_DAYS,
        blocked: blocked(),
        items: plan(days).map((m) => ({ ...m, day: dayName(m.dayStart) })),
      };
    },
    start(days = DEFAULT_DAYS) {
      const reason = blocked();
      if (reason) return { ok: false, reason };
      running = true;
      const planned = plan(days);
      job = { running: true, startedAt: Math.floor(now()), finishedAt: null, done: 0, total: planned.length, report: null };
      const mine = job;
      current = work(days, planned, mine);
      return { ok: true, job: { ...mine } };
    },

    status: () => ({ ...job }),
    planFor: plan,
    execute,
    settled: () => current,
  };

  async function execute(planned: PlanItem[], days: number, hooks: ExecuteHooks = {}): Promise<BackfillReport> {
    const items: ReportItem[] = [];
    let limited = false;
    let interrupted: string | undefined;
    for (const m of planned) {
      const base = { symbol: m.symbol, day: dayName(m.dayStart), dayStart: m.dayStart };
      const add = (status: BackfillStatus, extra: { bars?: number; reason?: string } = {}) =>
        items.push({ ...base, status, label: LABELS[status], ...extra });
      interrupted ??= hooks.shouldStop?.() ?? undefined;
      if (!m.inReach) {
        add("out_of_range", { reason: `Yahoo liefert Minutenbalken nur für die letzten ${REACH_DAYS} Tage.` });
      } else if (limited) {
        add("skipped", { reason: "Yahoo hat mit 429 abgelehnt; der Rest wurde nicht versucht." });
      } else if (interrupted) {
        add("skipped", { reason: `${interrupted}; der Rest wurde nicht versucht.` });
      } else {
        try {
          if (hooks.gapMs && items.some((i) => i.status !== "out_of_range")) await new Promise((r) => setTimeout(r, hooks.gapMs));
          const bars = await archive.fetchDay(m.symbol, m.dayStart);
          if (bars > 0) session.dataChanged();
          add(bars > 0 ? "loaded" : "empty", { bars });
        } catch (err) {
          if (err instanceof MarketDataError && err.kind === "rate_limited") limited = true;
          add("error", { reason: describeError(err) });
        }
      }
      hooks.onProgress?.(items.length);
    }
    const count = (s: BackfillStatus) => items.filter((i) => i.status === s).length;
    return {
      days,
      daysIsAssumption: days === DEFAULT_DAYS,
      stoppedByRateLimit: limited,
      ...(interrupted ? { interrupted } : {}),
      counts: {
        loaded: count("loaded"), empty: count("empty"), error: count("error"),
        skipped: count("skipped"), outOfRange: count("out_of_range"),
      },
      items,
    };
  }

  async function work(days: number, planned: PlanItem[], mine: BackfillJob): Promise<void> {
    try {
      mine.report = await execute(planned, days, { onProgress: (n) => (mine.done = n) });
    } catch (err) {
      mine.error = describeError(err);
    } finally {
      mine.running = false;
      mine.finishedAt = Math.floor(now());
      running = false;
    }
  }
}
