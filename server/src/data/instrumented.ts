import type { Db } from "../db.js";
import type { EcbSource } from "./ecb.js";
import { type DailyData, type MarketData, MarketDataError } from "./marketdata.js";
import type { InstrumentSearch } from "./search.js";

const HOUR = 3600;
const WINDOW_S = 24 * HOUR;

/**
 * What a call came to. The adapters throw `MarketDataError` and keep no HTTP status, so the kind
 * stands for it: "404" is an empty answer (`no_data`), "422" a shape or range the source refused
 * (`bad_shape`), "429" the throttle, "error" everything else (network, 5xx, a bug).
 */
export const CALL_KINDS = ["200", "404", "422", "429", "error"] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export const SOURCES = [
  { id: "yahoo-minute", label: "Yahoo, Minutenbalken" },
  { id: "yahoo-daily", label: "Yahoo, Tagesbalken" },
  { id: "yahoo-search", label: "Yahoo, Suche" },
  { id: "ecb", label: "EZB, Wechselkurse" },
] as const;
export type SourceId = (typeof SOURCES)[number]["id"];

export interface SourceSummary {
  source: SourceId;
  label: string;
  /** Calls in the last 24 hours (to the hour), by kind. */
  counts: Record<CallKind, number>;
  calls: number;
  /** Mean answer time of those calls in ms; null without calls. */
  meanMs: number | null;
  /** UTC seconds of the last call that was a 200, however long ago; null if there never was one. */
  lastOkAt: number | null;
  /** UTC seconds of the last call of any kind. */
  lastAt: number | null;
}

export interface SourceStats {
  record(source: SourceId, kind: CallKind, ms: number): void;
  summary(): SourceSummary[];
}

export function kindOf(err: unknown): CallKind {
  if (err instanceof MarketDataError) {
    if (err.kind === "no_data") return "404";
    if (err.kind === "bad_shape") return "422";
    if (err.kind === "rate_limited") return "429";
  }
  return "error";
}

/**
 * Counts per hour, kept in `source_stats`, so the numbers survive a restart and "the last 24 hours"
 * is the 24 hour buckets before now: a call drops out of the figure between 24 and 25 hours later.
 */
export function createSourceStats(db: Db, now: () => number): SourceStats {
  const upsert = db.prepare(
    "insert into source_stats (hour, source, kind, count, ms_total, last_at) values (?, ?, ?, 1, ?, ?) " +
      "on conflict (hour, source, kind) do update set count = count + 1, ms_total = ms_total + excluded.ms_total, " +
      "last_at = max(last_at, excluded.last_at)",
  );
  const recent = db.prepare(
    "select source, kind, sum(count) as n, sum(ms_total) as ms from source_stats where hour + ? > ? group by source, kind",
  );
  const lasts = db.prepare("select source, max(last_at) as at, max(case when kind = '200' then last_at end) as ok from source_stats group by source");

  return {
    record(source, kind, ms) {
      const t = Math.floor(now());
      try {
        upsert.run(Math.floor(t / HOUR) * HOUR, source, kind, Math.max(0, Math.round(ms)), t);
      } catch {
        // a closed database during shutdown: the figure is lost, the call is not
      }
    },

    summary() {
      const t = Math.floor(now());
      const rows = recent.all(HOUR, t - WINDOW_S) as { source: string; kind: CallKind; n: number; ms: number }[];
      const last = new Map((lasts.all() as { source: string; at: number | null; ok: number | null }[]).map((r) => [r.source, r]));
      return SOURCES.map(({ id, label }) => {
        const counts = Object.fromEntries(CALL_KINDS.map((k) => [k, 0])) as Record<CallKind, number>;
        let ms = 0;
        for (const r of rows) {
          if (r.source !== id) continue;
          counts[r.kind] = r.n;
          ms += r.ms;
        }
        const calls = CALL_KINDS.reduce((a, k) => a + counts[k], 0);
        return {
          source: id, label, counts, calls, meanMs: calls ? Math.round(ms / calls) : null,
          lastOkAt: last.get(id)?.ok ?? null, lastAt: last.get(id)?.at ?? null,
        };
      });
    },
  };
}

/** Times one call and counts how it ended; the result or the error goes on unchanged. */
async function counted<T>(stats: SourceStats, source: SourceId, call: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const out = await call();
    stats.record(source, "200", performance.now() - started);
    return out;
  } catch (err) {
    stats.record(source, kindOf(err), performance.now() - started);
    throw err;
  }
}

// The adapters stay as they are; these wrap them where `app.ts` joins them up.
export const instrumentMarketData = (inner: MarketData, stats: SourceStats): MarketData => ({
  bars: (symbol, fromT, toT) => counted(stats, "yahoo-minute", () => inner.bars(symbol, fromT, toT)),
});
export const instrumentDaily = (inner: DailyData, stats: SourceStats): DailyData => ({
  daily: (symbol, fromT, toT) => counted(stats, "yahoo-daily", () => inner.daily(symbol, fromT, toT)),
});
export const instrumentSearch = (inner: InstrumentSearch, stats: SourceStats): InstrumentSearch => ({
  search: (q) => counted(stats, "yahoo-search", () => inner.search(q)),
});
export const instrumentEcb = (inner: EcbSource, stats: SourceStats): EcbSource => ({
  fetch: (range) => counted(stats, "ecb", () => inner.fetch(range)),
});
