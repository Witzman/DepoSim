import { buildApp } from "./app.js";
import { dirname, join } from "node:path";
import { BACKUP_DIR, BACKUP_KEEP, DB_PATH, JOB_SETTINGS, PORT, SETTINGS } from "./config.js";

const app = buildApp({
  dbPath: DB_PATH,
  // Without BACKUP_DIR the backups sit beside the database, in the same volume: better than none, but the
  // volume is not in the server's backup (notes/reference/deploy.md), so production sets it.
  backupDir: BACKUP_DIR ?? join(dirname(DB_PATH), "backups"), backupKeep: BACKUP_KEEP, liveDelayS: SETTINGS.liveDelayS, catchUpTempo: SETTINGS.catchUpTempo, liveRefreshS: SETTINGS.liveRefreshS,
  // One look at the clock every 30 s; Yahoo calls of a scheduled run are 1 s apart (the buttons keep the 500 ms).
  jobSettings: JOB_SETTINGS, jobsTickMs: 30_000, jobGapMs: 1_000,
});
app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
