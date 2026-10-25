import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDb } from "./db.js";
import { describeError } from "./errors.js";

/** Tables of the price archive: it can be fetched again (for 30 days), so a backup leaves it out. */
export const ARCHIVE_TABLES = ["bars", "fetched_days", "bar_flags", "daily_bars", "dividends", "daily_fetched", "fx_daily", "fx_fetched", "job_runs", "source_stats"];
/** What a restore replaces, in the order they are written (parents first). */
const USER_TABLES = ["simulations", "instruments", "depots", "orders", "positions", "depot_values", "journal_notes", "cash_events", "hint_prefs"];

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

const DAILY = /^deposim-tag-(\d{4}-\d{2}-\d{2})\.sqlite$/;
const PRE_RESTORE = /^deposim-vor-wiederherstellung-\d{8}-\d{6}\.sqlite$/;
const SQLITE_MAGIC = "SQLite format 3\0";

const pad = (n: number) => String(n).padStart(2, "0");
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const stamp = (s: number) => {
  const d = new Date(s * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

export interface BackupLogEntry {
  at: number;
  ok: boolean;
  text: string;
}

export interface BackupStatus {
  /** False: no folder is set, so there is no daily backup. */
  enabled: boolean;
  dir: string | null;
  keep: number;
  /** UTC seconds of the newest daily backup; null if there is none. */
  lastAt: number | null;
  lastName: string | null;
  lastBytes: number | null;
  /** The last daily backup that failed and no later one has succeeded; null otherwise. */
  error: { at: number; message: string } | null;
  /** The newest entries of the job log, newest first. */
  log: BackupLogEntry[];
}

export interface BackupService {
  /** A consistent copy of the whole state without the price archive, as bytes. */
  snapshot(): Promise<{ name: string; data: Buffer }>;
  /** Writes today's backup if there is none yet, then drops the oldest ones. Never throws: a failure goes to the log. */
  runDaily(): Promise<void>;
  /** A backup of the current state before a restore. Throws if it cannot be written. */
  preRestore(): Promise<string>;
  status(): BackupStatus;
}

/** A copy of the live database made with the online backup API, so it is whole even while a writer is busy. */
async function copyOf(db: Db, target: string): Promise<void> {
  await db.backup(target);
  const copy = new Database(target);
  try {
    // Drop the price archive first, then compact: the file does not grow with the archive.
    for (const table of ARCHIVE_TABLES) copy.exec(`drop table if exists ${table}`);
    copy.pragma("journal_mode = DELETE");
    copy.exec("vacuum");
    const result = copy.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new BackupError(`Die Sicherung ist beschädigt (${String(result)}).`);
  } finally {
    copy.close();
  }
}

export function createBackupService(deps: {
  db: Db;
  /** Where the daily backups go; undefined: none are made. */
  dir?: string;
  keep?: number;
  now: () => number;
  log?: (text: string, ok: boolean) => void;
}): BackupService {
  const { db, dir, now } = deps;
  const keep = Math.max(1, Math.floor(deps.keep ?? 7));
  const entries: BackupLogEntry[] = [];
  let error: BackupStatus["error"] = null;

  const record = (ok: boolean, text: string) => {
    entries.unshift({ at: Math.floor(now()), ok, text });
    entries.length = Math.min(entries.length, 20);
    deps.log?.(text, ok);
  };

  /** Runs `fn` with a scratch folder that is removed afterwards. */
  async function scratch<T>(fn: (folder: string) => Promise<T>): Promise<T> {
    const folder = mkdtempSync(join(tmpdir(), "deposim-backup-"));
    try {
      return await fn(folder);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  function listDir(pattern: RegExp): { name: string; mtime: number; bytes: number }[] {
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => pattern.test(n))
      .map((name) => {
        const s = statSync(join(dir, name));
        return { name, mtime: Math.floor(s.mtimeMs / 1000), bytes: s.size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Writes a verified copy as `name` in the backup folder; the file appears only when it is whole. */
  async function writeInto(name: string): Promise<number> {
    if (!dir) throw new BackupError("Kein Sicherungsordner eingestellt.");
    mkdirSync(dir, { recursive: true });
    const partial = join(dir, `${name}.teil`);
    try {
      await copyOf(db, partial);
      const bytes = statSync(partial).size;
      renameSync(partial, join(dir, name));
      return bytes;
    } finally {
      rmSync(partial, { force: true });
    }
  }

  function prune() {
    for (const [pattern, limit] of [[DAILY, keep], [PRE_RESTORE, 5]] as const) {
      const files = listDir(pattern);
      for (const f of files.slice(0, Math.max(0, files.length - limit))) rmSync(join(dir!, f.name), { force: true });
    }
  }

  return {
    async snapshot() {
      const name = `deposim-sicherung-${stamp(now())}.sqlite`;
      return scratch(async (folder) => {
        const file = join(folder, name);
        await copyOf(db, file);
        return { name, data: readFileSync(file) };
      });
    },

    async runDaily() {
      if (!dir) return;
      const today = day(now());
      try {
        if (!listDir(DAILY).some((f) => f.name === `deposim-tag-${today}.sqlite`)) {
          const name = `deposim-tag-${today}.sqlite`;
          const bytes = await writeInto(name);
          record(true, `Tagessicherung ${name} geschrieben (${bytes} Bytes).`);
        }
        prune();
        error = null;
      } catch (err) {
        const message = describeError(err);
        error = { at: Math.floor(now()), message };
        record(false, `Tagessicherung fehlgeschlagen: ${message}`);
      }
    },

    async preRestore() {
      const name = `deposim-vor-wiederherstellung-${stamp(now())}.sqlite`;
      if (dir) {
        await writeInto(name);
        prune();
        return name;
      }
      // No folder set (only tests): there is nowhere to keep it, but the copy is still made and checked.
      await scratch((folder) => copyOf(db, join(folder, name)));
      return name;
    },

    status() {
      const daily = listDir(DAILY);
      const last = daily.at(-1) ?? null;
      return {
        enabled: dir !== undefined,
        dir: dir ?? null,
        keep,
        lastAt: last ? last.mtime : null,
        lastName: last?.name ?? null,
        lastBytes: last?.bytes ?? null,
        error,
        log: [...entries],
      };
    },
  };
}

const columnsOf = (db: Db, schema: string, table: string) =>
  (db.prepare(`pragma ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Replaces the simulations, depots, orders, positions, curves, notes and added instruments of `db`
 * with those in `data`, a file made by `snapshot()`. The price archive stays as it is. All or nothing:
 * a file that is not a backup is refused before anything is touched, and the write is one transaction.
 * `beforeApply` runs once the file has passed the checks and before the first write (the safety backup).
 */
export async function restoreInto(db: Db, data: Buffer, beforeApply?: () => Promise<void>): Promise<{ simulations: number }> {
  if (data.length < 100 || data.subarray(0, SQLITE_MAGIC.length).toString("latin1") !== SQLITE_MAGIC) {
    throw new BackupError("Das ist keine Sicherungsdatei von DepoSim (keine SQLite-Datenbank).");
  }
  const folder = mkdtempSync(join(tmpdir(), "deposim-restore-"));
  const file = join(folder, "upload.sqlite");
  try {
    // Written out, then opened: the copy may be an older schema, which openDb brings up to date.
    // (Node has no way to open from memory here.)
    writeFileSync(file, data);
    let probe: Db;
    try {
      probe = new Database(file, { readonly: true });
    } catch {
      throw new BackupError("Die Datei lässt sich nicht als Datenbank öffnen.");
    }
    try {
      const tables = (probe.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((r) => r.name);
      for (const t of ["simulations", "depots", "orders"]) {
        if (!tables.includes(t)) throw new BackupError("Die Datei ist keine Sicherung von DepoSim (Tabelle fehlt: " + t + ").");
      }
      if (probe.pragma("integrity_check", { simple: true }) !== "ok") throw new BackupError("Die Sicherungsdatei ist beschädigt.");
    } catch (err) {
      if (err instanceof BackupError) throw err;
      throw new BackupError("Die Datei lässt sich nicht als Datenbank lesen.");
    } finally {
      probe.close();
    }
    openDb(file).close(); // migrates an older schema

    await beforeApply?.();
    db.prepare("attach database ? as restore_src").run(file);
    try {
      return db.transaction(() => {
        db.exec("delete from simulations; delete from instruments;"); // depots, orders, ... follow by cascade
        for (const table of USER_TABLES) {
          const have = new Set(columnsOf(db, "restore_src", table));
          if (have.size === 0) continue; // a backup older than this table has nothing to bring back
          const cols = columnsOf(db, "main", table).filter((c) => have.has(c)).join(", ");
          db.exec(`insert into main.${table} (${cols}) select ${cols} from restore_src.${table}`);
        }
        return { simulations: (db.prepare("select count(*) as n from simulations").get() as { n: number }).n };
      })();
    } finally {
      db.exec("detach database restore_src");
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
