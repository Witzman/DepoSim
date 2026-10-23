import { buildApp } from "./app.js";
import { DB_PATH, PORT, SETTINGS } from "./config.js";

const app = buildApp({
  dbPath: DB_PATH, liveDelayS: SETTINGS.liveDelayS, catchUpTempo: SETTINGS.catchUpTempo,
});
app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
