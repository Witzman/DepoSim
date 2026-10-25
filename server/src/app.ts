import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerApi } from "./api.js";
import { createBackfill } from "./backfill.js";
import { type BackupService, createBackupService } from "./backup.js";
import { FX_SYMBOL, type Instrument, WATCHLIST } from "./config.js";
import { createArchive } from "./data/archive.js";
import { type EcbSource, createEcb } from "./data/ecb.js";
import type { DailyData, MarketData } from "./data/marketdata.js";
import { type InstrumentSearch, createYahooSearch } from "./data/search.js";
import { createYahoo, createYahooDaily } from "./data/yahoo.js";
import { openDb } from "./db.js";
import { type Fx, createFx } from "./fx.js";
import { InstrumentRegistry } from "./instruments.js";
import { createLongterm } from "./longterm.js";
import { SessionService } from "./session.js";
import { createStore } from "./store.js";
import { createHub } from "./ws.js";

export interface AppOptions {
  dbPath: string;
  /** The price source. Defaults to Yahoo. */
  marketData?: MarketData;
  /** The daily-price source of the long-term comparison. Defaults to Yahoo. */
  dailyData?: DailyData;
  instruments?: Instrument[];
  /** The instrument search. Defaults to Yahoo. */
  search?: InstrumentSearch;
  /** Current time in UTC seconds. */
  now?: () => number;
  /** Pause between two calls to the price source. */
  minGapMs?: number;
  /** How often a running simulation ticks. */
  tickMs?: number;
  /** How far behind the present the price source is, in seconds. */
  liveDelayS?: number;
  /** The tempo a live simulation catches up at. */
  catchUpTempo?: number;
  /** The shortest time between two refreshes of today's prices, in seconds. */
  liveRefreshS?: number;
  /** Folder of the daily backups; without it there are none. */
  backupDir?: string;
  /** How many daily backups are kept. */
  backupKeep?: number;
  /** How often the daily backup is looked at, in ms; 0: never (tests call it themselves). */
  backupCheckMs?: number;
  /** The ECB reference rates. Defaults to the ECB. */
  fxSource?: EcbSource;
  /**
   * How often the daily rate fetch is looked at, in ms; 0: never (tests call `app.fx` themselves).
   * A stand-in until the scheduler (#48) calls `fx.runDaily()` at 16:30 Berlin.
   */
  fxCheckMs?: number;
}

declare module "fastify" {
  interface FastifyInstance {
    session: SessionService;
    backup: BackupService;
    fx: Fx;
  }
}

// server/src and server/dist are the same depth, so one path serves dev and the image.
const WEB_DIST = resolve(import.meta.dirname, "../../web/dist");

export function buildApp(opts: AppOptions): FastifyInstance {
  if (opts.dbPath !== ":memory:") mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = openDb(opts.dbPath);
  const store = createStore(db);
  const instruments = new InstrumentRegistry(db, opts.instruments ?? WATCHLIST);
  const archive = createArchive(db, opts.marketData ?? createYahoo(), { minGapMs: opts.minGapMs, now: opts.now });
  const session = new SessionService({
    store, archive, instruments, fxSymbol: FX_SYMBOL, now: opts.now,
    delayS: opts.liveDelayS, catchUpTempo: opts.catchUpTempo,
  });
  const backfill = createBackfill({ archive, store, session, instruments, now: opts.now ?? (() => Date.now() / 1000) });
  const nowS = opts.now ?? (() => Date.now() / 1000);
  const fxLog = (text: string, ok: boolean) => (ok ? app.log.info(text) : app.log.error(text));
  const fx = createFx({ db, source: opts.fxSource ?? createEcb(), now: nowS, log: fxLog });
  const longterm = createLongterm({
    db, source: opts.dailyData ?? createYahooDaily(), now: nowS, minGapMs: opts.minGapMs, fx,
  });
  const hub = createHub(session, store, opts.tickMs ?? 250, opts.liveRefreshS ?? 60);

  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const backup = createBackupService({
    db, dir: opts.backupDir, keep: opts.backupKeep, now: opts.now ?? (() => Date.now() / 1000),
    log: (text, ok) => (ok ? app.log.info(text) : app.log.error(text)),
  });
  app.decorate("session", session);
  app.decorate("backup", backup);
  app.decorate("fx", fx);
  // Once at start (only if the rates are missing or old), then a look every hour: the fetch itself happens once a day.
  const fxMs = opts.fxCheckMs ?? 0;
  let fxTimer: NodeJS.Timeout | undefined;
  if (fxMs > 0) {
    setTimeout(() => void fx.runStartup(), 3_000).unref();
    fxTimer = setInterval(() => void fx.runDaily(), fxMs);
    fxTimer.unref();
  }
  // The first look is at once (a missed night is made up), then every hour; a failure is in the job log, never thrown.
  const checkMs = opts.backupCheckMs ?? 3_600_000;
  let backupTimer: NodeJS.Timeout | undefined;
  if (opts.backupDir && checkMs > 0) {
    setTimeout(() => void backup.runDaily(), 5_000).unref();
    backupTimer = setInterval(() => void backup.runDaily(), checkMs);
    backupTimer.unref();
  }
  app.addHook("onClose", async () => {
    if (backupTimer) clearInterval(backupTimer);
    if (fxTimer) clearInterval(fxTimer);
    hub.stopAll();
    db.close();
  });

  app.register(fastifyWebsocket);
  app.register(async (instance) => {
    instance.get("/ws/simulations/:id", { websocket: true }, (socket, req) => {
      hub.attach(socket, Number((req.params as { id: string }).id));
    });
  });

  app.get("/healthz", async (_req, reply) => reply.type("text/plain").send("ok"));
  registerApi(app, { store, session, archive, instruments, search: opts.search ?? createYahooSearch(), hub, backfill, longterm, fx, db, backup, now: opts.now ?? (() => Date.now() / 1000) });

  if (existsSync(WEB_DIST)) {
    app.register(fastifyStatic, { root: WEB_DIST });
  }
  return app;
}
