import { buildApp } from "./app.js";
import { DB_PATH, PORT } from "./config.js";

const app = buildApp({ dbPath: DB_PATH });
app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
