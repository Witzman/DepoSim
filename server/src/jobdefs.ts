import type { Archive } from "./data/archive.js";
import type { Backfill, BackfillReport } from "./backfill.js";
import { REACH_DAYS } from "./backfill.js";
import type { BackupService } from "./backup.js";
import { FX_SYMBOL, VENUES, type VenueId } from "./config.js";
import type { Db } from "./db.js";
import { localTime, sessionFor } from "./domain/venues.js";
import type { Fx } from "./fx.js";
import type { InstrumentRegistry } from "./instruments.js";
import type { JobDef, JobOutcome } from "./jobs.js";
import type { Longterm } from "./longterm.js";

const DAY = 86400;

/** How long job records are kept. */
const KEEP_RUNS_DAYS = 90;

/** How many days back the nightly plausibility check looks. */
export const CHECK_DAYS = 30;

/** What a backfill report says about a scheduled run. */
function outcomeOf(report: BackfillReport, what: string): JobOutcome {
  const c = report.counts;
  const parts = [`${c.loaded} geladen`, `${c.empty} leer`];
  if (c.error) parts.push(`${c.error} Fehler`);
  if (c.skipped) parts.push(`${c.skipped} übersprungen`);
  const counts = { loaded: c.loaded, empty: c.empty, error: c.error, skipped: c.skipped, rateLimited: report.stoppedByRateLimit ? 1 : 0 };
  const tail = report.stoppedByRateLimit ? " Yahoo hat mit 429 abgelehnt; der Rest folgt am nächsten Tag."
    : report.interrupted ? ` Abgebrochen: ${report.interrupted}.` : "";
  const status = report.interrupted ? "aborted" : report.stoppedByRateLimit || c.error > 0 ? "partial" : "ok";
  return { status, message: `${what}: ${parts.join(", ")}.${tail}`, counts };
}

export function buildJobDefs(deps: {
  db: Db;
  archive: Archive;
  backfill: Backfill;
  instruments: InstrumentRegistry;
  longterm: Longterm;
  fx: Fx;
  backup: BackupService;
  /** Whether the daily backup is configured (a folder is set). */
  backupOn: boolean;
  now: () => number;
  /** Pause between two calls to Yahoo in a scheduled run, in ms. */
  gapMs: number;
}): JobDef[] {
  const { db, backfill, instruments, longterm, fx, backup, now, gapMs } = deps;

  /** Collects the day of the market that has just closed for the instruments listed on it. */
  const collect = (venueId: VenueId, at: string): JobDef => {
    const venue = VENUES.find((v) => v.id === venueId)!;
    return {
      name: `sammlung-${venueId.toLowerCase()}`,
      label: `Tagessammlung ${venue.name}`,
      at,
      usesSource: true,
      async run(ctx) {
        const day = localTime(venue.timeZone, ctx.slot).day;
        const session = sessionFor(venue, day);
        if (!session.trading) return { status: "ok", message: `${venue.name} ${day}: kein Handelstag (${session.reason}), nichts geladen.`, counts: { loaded: 0 } };
        const symbols = instruments.list().filter((i) => i.venue === venueId).map((i) => i.symbol);
        const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
        const items = deps.archive.missingDays(symbols, dayStart, dayStart + DAY).map((m) => ({ ...m, inReach: true }));
        const report = await backfill.execute(items, 1, { gapMs, shouldStop: ctx.shouldStop });
        return outcomeOf(report, `${venue.name} ${day}, ${symbols.length} Werte`);
      },
    };
  };

  const defs: JobDef[] = [
    // Xetra shuts 17:30 Berlin, the US cash session 22:00 Berlin (both zones change clocks within a few weeks of each other,
    // so 22:00 holds all year); half an hour of margin each. Both land on the same UTC date as the market's own date.
    collect("XETRA", "18:00"),
    collect("US", "22:30"),
    {
      name: "luecken", label: "Lückenreparatur", at: "02:30", usesSource: true,
      async run(ctx) {
        // At 02:30 Berlin the UTC day before is over (in winter 01:30, in summer 00:30 UTC), so it counts as finished.
        const items = backfill.planFor(REACH_DAYS).filter((m) => m.inReach);
        const report = await backfill.execute(items, REACH_DAYS, { gapMs, shouldStop: ctx.shouldStop });
        return outcomeOf(report, `Lücken der letzten ${REACH_DAYS} Tage`);
      },
    },
    {
      name: "tageskurse", label: "Tageskurse und Ausschüttungen", at: "03:30", usesSource: true,
      async run() {
        const started = longterm.start();
        if (!started.ok) return { status: "aborted", message: started.reason };
        await longterm.settled();
        const job = longterm.status();
        const n = (s: string) => job.items.filter((i) => i.status === s).length;
        const counts = { loaded: n("loaded"), current: n("current"), error: n("error"), skipped: n("skipped") };
        const text = `${counts.loaded} geladen, ${counts.current} aktuell` + (counts.error ? `, ${counts.error} Fehler` : "") + (counts.skipped ? `, ${counts.skipped} übersprungen` : "") + ".";
        if (job.error) throw new Error(job.error);
        return { status: counts.error > 0 || job.stoppedByRateLimit ? "partial" : "ok", message: text, counts };
      },
    },
    {
      // After the collections and the daily prices: the comparison with the daily close needs those.
      name: "pruefung", label: "Plausibilitätsprüfung der Kurse", at: "03:45", usesSource: false,
      async run() {
        const to = (Math.floor(now() / DAY) + 1) * DAY;
        const symbols = [...instruments.list().map((i) => i.symbol), FX_SYMBOL];
        let bars = 0, spike = 0, daily = 0;
        for (const symbol of symbols) {
          const r = deps.archive.recheck(symbol, to - CHECK_DAYS * DAY, to);
          bars += r.bars; spike += r.spike; daily += r.daily;
        }
        return {
          status: "ok",
          message: `${symbols.length} Reihen, ${bars} Balken geprüft: ${spike} Ausreißer, ${daily} Abweichungen vom Tagesschluss.`,
          counts: { series: symbols.length, bars, spike, daily },
        };
      },
    },
    {
      name: "wechselkurse", label: "EZB-Wechselkurse", at: "16:30", usesSource: false, retryErrorS: 3600,
      async run() {
        await fx.runDaily();
        const status = fx.status();
        if (status.error) throw new Error(status.error);
        return { status: "ok", message: `Neuester Kurs vom ${status.latestDay ?? "-"}.` };
      },
    },
    {
      name: "pflege", label: "Pflege der Datenbank", at: "04:00", usesSource: false,
      async run(ctx) {
        db.pragma("wal_checkpoint(TRUNCATE)");
        const weekday = new Date(`${localTime("Europe/Berlin", ctx.slot).day}T00:00:00Z`).getUTCDay();
        // ANALYZE reads every index; weekly is plenty for the planner and spares the disk on a big archive.
        if (weekday === 0) db.exec("analyze");
        const pruned = db.prepare("delete from job_runs where started_at < ?").run(Math.floor(now()) - KEEP_RUNS_DAYS * DAY).changes;
        const prunedStats = db.prepare("delete from source_stats where hour < ?").run(Math.floor(now()) - KEEP_RUNS_DAYS * DAY).changes;
        return { status: "ok", message: `Protokoll gekürzt (${pruned} alte Einträge)${weekday === 0 ? ", ANALYZE" : ""}.`, counts: { pruned, prunedStats } };
      },
    },
  ];

  if (deps.backupOn) {
    defs.splice(3, 0, {
      name: "sicherung", label: "Tagessicherung", at: "03:00", usesSource: false, retryErrorS: 3600,
      async run() {
        const before = Math.floor(now());
        await backup.runDaily();
        const status = backup.status();
        if (status.error && status.error.at >= before) throw new Error(status.error.message);
        const entry = status.log.find((e) => e.at >= before);
        return { status: "ok", message: entry?.text ?? `Tagessicherung ${status.lastName ?? ""} ist schon da.` };
      },
    });
  }
  return defs;
}
