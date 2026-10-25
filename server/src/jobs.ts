import type { JobSettings } from "./config.js";
import type { Db } from "./db.js";
import { localTime } from "./domain/venues.js";
import { describeError } from "./errors.js";

const DAY = 86400;
const ZONE = "Europe/Berlin";

export type RunStatus = "running" | "ok" | "partial" | "aborted" | "error";

export const STATUS_LABELS: Record<RunStatus, string> = {
  running: "läuft", ok: "erledigt", partial: "teilweise", aborted: "abgebrochen", error: "Fehler",
};

export interface JobOutcome {
  /** "ok", "partial" (a rate limit or single failures) or "aborted" (stopped from outside; tried again at the next look). */
  status: "ok" | "partial" | "aborted";
  message: string;
  counts?: Record<string, number>;
}

export interface JobContext {
  /** UTC seconds of the scheduled time this run is for: the day to collect is taken from it, not from the clock. */
  slot: number;
  /** A reason to stop before the next call to a source (a live simulation runs, shutdown), or null. */
  shouldStop(): string | null;
}

export interface JobDef {
  name: string;
  label: string;
  /** Local "HH:MM" in Europe/Berlin, every day. Weekends and holidays are decided by the job itself. */
  at: string;
  /** Calls Yahoo or another source: waits for a live simulation and stops when one starts. */
  usesSource: boolean;
  /** After an unexpected failure: try again after this many seconds (once per look). Absent: next day. */
  retryErrorS?: number;
  run(ctx: JobContext): Promise<JobOutcome>;
}

export interface JobRun {
  id: number;
  job: string;
  trigger: "plan" | "hand";
  slot: number | null;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  label: string;
  message: string | null;
  counts: Record<string, number> | null;
  error: string | null;
}

export interface JobInfo {
  name: string;
  label: string;
  schedule: string;
  enabled: boolean;
  /** UTC seconds of the next scheduled run; null when the job is off. */
  nextAt: number | null;
  running: boolean;
  queued: boolean;
  lastRun: JobRun | null;
}

export type RunRequest = { ok: true } | { ok: false; code: 404 | 409; reason: string };

export interface Jobs {
  list(): JobInfo[];
  runs(limit?: number): JobRun[];
  /** Looks at the clock: every job whose time has passed without a finished run is queued. Resolves when the queue is empty. */
  tick(): Promise<void>;
  /** Queues a job by hand. */
  run(name: string): RunRequest;
  /** Asks for the gap repair after the watchlist grew; does nothing when the scheduler is off. */
  warmUp(): void;
  /** Starts the timer: a look at the clock every `ms`. */
  start(ms: number): void;
  /** Stops the timer and asks the running job to stop. Resolves when it has. */
  stop(): Promise<void>;
  settled(): Promise<void>;
  readonly enabled: boolean;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY * 1000).toISOString().slice(0, 10);

/** UTC seconds of local `HH:MM` on local `day` in the zone (summer time included). */
export function zonedToUtc(zone: string, day: string, hhmm: string): number {
  const guess = Date.parse(`${day}T${hhmm}:00Z`) / 1000;
  const offsetAt = (t: number) => {
    const l = localTime(zone, t);
    return Date.parse(`${l.day}T00:00:00Z`) / 1000 + l.minutes * 60 - t;
  };
  return guess - offsetAt(guess - offsetAt(guess));
}

/** The latest scheduled time at or before `now` and the first after it, of a daily job. */
export function slotsAround(at: string, now: number, zone = ZONE): { last: number; next: number } {
  const today = localTime(zone, now).day;
  const slots = [-1, 0, 1].map((k) => zonedToUtc(zone, addDays(today, k), at));
  return { last: slots.filter((s) => s <= now).at(-1)!, next: slots.find((s) => s > now)! };
}

interface Row {
  id: number; job: string; trigger: "plan" | "hand"; slot: number | null; started_at: number; finished_at: number | null;
  status: RunStatus; message: string | null; counts: string | null; error: string | null;
}

const shown = (r: Row): JobRun => ({
  id: r.id, job: r.job, trigger: r.trigger, slot: r.slot, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status,
  label: STATUS_LABELS[r.status], message: r.message, counts: r.counts ? JSON.parse(r.counts) : null, error: r.error,
});

export function createJobs(deps: {
  db: Db;
  now: () => number;
  defs: JobDef[];
  settings: JobSettings;
  /** True while a live simulation is running: jobs that call a source wait. */
  liveBusy: () => boolean;
  log?: (text: string, ok: boolean) => void;
}): Jobs {
  const { db, now, defs, settings } = deps;

  // A job that was running when the process ended did not finish; it says so, and the next look tries it again.
  db.prepare("update job_runs set status = 'aborted', finished_at = ?, error = ? where status = 'running'")
    .run(Math.floor(now()), "Der Server wurde während des Laufs beendet oder neu gestartet.");

  const atOf = (d: JobDef) => {
    const o = settings.overrides[d.name];
    return o === "off" ? null : (o ?? d.at);
  };
  const active = (d: JobDef) => settings.enabled && atOf(d) !== null;

  const insert = db.prepare(
    "insert into job_runs (job, trigger, slot, started_at, status) values (?, ?, ?, ?, 'running')",
  );
  const finish = db.prepare(
    "update job_runs set finished_at = ?, status = ?, message = ?, counts = ?, error = ? where id = ?",
  );
  const lastForSlot = db.prepare(
    "select status, finished_at from job_runs where job = ? and trigger = 'plan' and slot = ? order by id desc limit 1",
  );
  const lastOf = db.prepare("select * from job_runs where job = ? order by id desc limit 1");
  const recent = db.prepare("select * from job_runs order by id desc limit ?");

  const queue: { def: JobDef; trigger: "plan" | "hand"; slot: number }[] = [];
  let currentName: string | null = null;
  let draining: Promise<void> = Promise.resolve();
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let first: NodeJS.Timeout | undefined;

  const queued = (name: string) => currentName === name || queue.some((q) => q.def.name === name);
  const lastSlot = (d: JobDef) => slotsAround(atOf(d) ?? d.at, now()).last;

  function due(d: JobDef): boolean {
    if (!active(d) || queued(d.name)) return false;
    if (d.usesSource && deps.liveBusy()) return false;
    const slot = lastSlot(d);
    const row = lastForSlot.get(d.name, slot) as { status: RunStatus; finished_at: number | null } | undefined;
    if (!row) return true;
    if (row.status === "aborted") return true;
    return row.status === "error" && d.retryErrorS !== undefined && now() - (row.finished_at ?? 0) >= d.retryErrorS;
  }

  function enqueue(d: JobDef, trigger: "plan" | "hand") {
    queue.push({ def: d, trigger, slot: lastSlot(d) });
    // One at a time, in order: the next job starts only when the one before has ended.
    draining = draining.then(drain).catch(() => undefined);
  }

  async function drain() {
    while (queue.length > 0 && !stopping) {
      const { def, trigger, slot } = queue.shift()!;
      if (trigger === "plan" && def.usesSource && deps.liveBusy()) continue; // still due at the next look
      currentName = def.name;
      // Whatever goes wrong here, even in the log table itself, ends this one job and not the scheduler: a rejected
      // chain would never run another job, and `void tick()` would turn it into an unhandled rejection.
      try {
        const id = Number(insert.run(def.name, trigger, slot, Math.floor(now())).lastInsertRowid);
        let status: RunStatus = "ok";
        let message: string | null = null;
        let counts: string | null = null;
        let error: string | null = null;
        try {
          const out = await def.run({
            slot,
            shouldStop: () => (stopping ? "Der Server wird beendet" : def.usesSource && deps.liveBusy() ? "Eine Live-Simulation läuft" : null),
          });
          status = out.status;
          message = out.message;
          counts = out.counts ? JSON.stringify(out.counts) : null;
        } catch (err) {
          status = "error";
          error = describeError(err);
        }
        finish.run(Math.floor(now()), status, message, counts, error, id);
        deps.log?.(`Auftrag ${def.name}: ${STATUS_LABELS[status]}${message ? `, ${message}` : ""}${error ? `, ${error}` : ""}`, status !== "error");
      } catch (err) {
        deps.log?.(`Auftrag ${def.name}: das Protokoll ließ sich nicht schreiben: ${describeError(err)}`, false);
      } finally {
        currentName = null;
      }
    }
  }

  return {
    enabled: settings.enabled,

    list() {
      return defs.map((d) => {
        const at = atOf(d);
        const last = lastOf.get(d.name) as Row | undefined;
        return {
          name: d.name, label: d.label,
          schedule: at ? `täglich ${at} (${ZONE})` : "aus",
          enabled: active(d),
          nextAt: active(d) ? slotsAround(at!, now()).next : null,
          running: currentName === d.name,
          queued: queue.some((q) => q.def.name === d.name),
          lastRun: last ? shown(last) : null,
        };
      });
    },

    runs: (limit = 30) => (recent.all(Math.max(1, Math.min(200, limit))) as Row[]).map(shown),

    tick() {
      for (const d of defs) if (due(d)) enqueue(d, "plan");
      return draining;
    },

    run(name) {
      const d = defs.find((x) => x.name === name);
      if (!d) return { ok: false, code: 404, reason: `Unbekannter Auftrag ${name}.` };
      if (queued(name)) return { ok: false, code: 409, reason: "Dieser Auftrag läuft oder wartet bereits." };
      if (d.usesSource && deps.liveBusy()) {
        return { ok: false, code: 409, reason: "Eine Live-Simulation läuft. Bitte zuerst pausieren oder beenden." };
      }
      enqueue(d, "hand");
      return { ok: true };
    },

    warmUp() {
      const d = defs.find((x) => x.name === "luecken");
      if (d && timer && active(d) && !queued(d.name) && !(d.usesSource && deps.liveBusy())) enqueue(d, "hand");
    },

    start(ms) {
      if (timer || ms <= 0) return;
      // The first look is at once: a night the server slept through is made up.
      first = setTimeout(() => void this.tick(), 3_000);
      first.unref();
      timer = setInterval(() => void this.tick(), ms);
      timer.unref();
    },

    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      if (first) clearTimeout(first);
      timer = undefined;
      await draining;
    },

    settled: () => draining,
  };
}
