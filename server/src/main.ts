import { buildApp } from "./app.js";
import { dirname, join } from "node:path";
import { BACKUP_DIR, BACKUP_KEEP, DB_PATH, PORT, SETTINGS } from "./config.js";

const app = buildApp({
  dbPath: DB_PATH,
  // Without BACKUP_DIR the backups sit beside the database, in the same volume: better than none, but the
  // volume is not in the server's backup (notes/reference/deploy.md), so production sets it.
  backupDir: BACKUP_DIR ?? join(dirname(DB_PATH), "backups"), backupKeep: BACKUP_KEEP, liveDelayS: SETTINGS.liveDelayS, catchUpTempo: SETTINGS.catchUpTempo, liveRefreshS: SETTINGS.liveRefreshS,
});
app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
