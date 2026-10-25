import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerApi } from "./api.js";
import { buildJobDefs } from "./jobdefs.js";
import { type Jobs, createJobs } from "./jobs.js";
import { createBackfill } from "./backfill.js";
import { type BackupService, createBackupService } from "./backup.js";
import { FX_SYMBOL, type Instrument, type JobSettings, WATCHLIST } from "./config.js";
import { dailyTolerance } from "./domain/quality.js";
import { createArchive } from "./data/archive.js";
import { createSourceStats, instrumentDaily, instrumentEcb, instrumentMarketData, instrumentSearch } from "./data/instrumented.js";
import { type EcbSource, createEcb } from "./data/ecb.js";
import type { DailyData, MarketData } from "./data/marketdata.js";
import { type InstrumentSearch, createYahooSearch } from "./data/search.js";
import { createYahoo, createYahooDaily } from "./data/yahoo.js";
import { openDb } from "./db.js";
import { type Health, createHealth } from "./health.js";
import { type Fx, createFx } from "./fx.js";
import { InstrumentRegistry } from "./instruments.js";
import { createEvents } from "./events.js";
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
  /** The scheduler (#48): `enabled: false` is `JOBS=off`; `overrides` change or switch off single jobs. */
  jobSettings?: JobSettings;
  /** How often the scheduler looks at the clock, in ms; 0: never (tests call `app.jobs.tick()` themselves). */
  jobsTickMs?: number;
  /** Pause between two Yahoo calls of a scheduled run, in ms. */
  jobGapMs?: number;
  /** The ECB reference rates. Defaults to the ECB. */
  fxSource?: EcbSource;
}

declare module "fastify" {
  interface FastifyInstance {
    session: SessionService;
    backup: BackupService;
    fx: Fx;
    jobs: Jobs;
    health: Health;
  }
}

// server/src and server/dist are the same depth, so one path serves dev and the image.
const WEB_DIST = resolve(import.meta.dirname, "../../web/dist");

export function buildApp(opts: AppOptions): FastifyInstance {
  if (opts.dbPath !== ":memory:") mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = openDb(opts.dbPath);
  const nowS = opts.now ?? (() => Date.now() / 1000);
  // Every call to a source is counted where the adapters are joined up (#49); the adapters themselves do not know.
  const stats = createSourceStats(db, nowS);
  const store = createStore(db);
  const instruments = new InstrumentRegistry(db, opts.instruments ?? WATCHLIST);
  const archive = createArchive(db, instrumentMarketData(opts.marketData ?? createYahoo(), stats), {
    minGapMs: opts.minGapMs, now: opts.now,
    dailyTolerance: (symbol) => { const i = instruments.get(symbol); return dailyTolerance(i?.venue ?? "", i?.kind); },
  });
  // Tests that do not hand in a daily source book no events: they must not reach for Yahoo.
  const dailySource = instrumentDaily(opts.dailyData ?? createYahooDaily(), stats);
  const events = opts.dailyData || process.env.NODE_ENV !== "test"
    ? createEvents({ db, source: dailySource, now: nowS, log: (text) => app.log.warn(text) })
    : undefined;
  const session = new SessionService({
    store, archive, instruments, fxSymbol: FX_SYMBOL, now: opts.now,
    delayS: opts.liveDelayS, catchUpTempo: opts.catchUpTempo, events,
  });
  const backfill = createBackfill({ archive, store, session, instruments, now: opts.now ?? (() => Date.now() / 1000) });
  const fxLog = (text: string, ok: boolean) => (ok ? app.log.info(text) : app.log.error(text));
  const fx = createFx({ db, source: instrumentEcb(opts.fxSource ?? createEcb(), stats), now: nowS, log: fxLog });
  const longterm = createLongterm({
    db, source: dailySource, now: nowS, minGapMs: opts.minGapMs, fx,
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
  // The scheduler owns every timed job: collection, repair, daily prices, rates, backup, upkeep.
  const jobs = createJobs({
    db, now: nowS, settings: opts.jobSettings ?? { enabled: true, overrides: {} },
    liveBusy: () => store.listSimulations().some((s) => s.live && s.endedAt === null && session.isRunning(s.id)),
    log: (text, ok) => (ok ? app.log.info(text) : app.log.error(text)),
    defs: buildJobDefs({
      db, archive, backfill, instruments, longterm, fx, backup, backupOn: opts.backupDir !== undefined, now: nowS, gapMs: opts.jobGapMs ?? 0,
    }),
  });
  app.decorate("jobs", jobs);
  const health = createHealth({ db, instruments, stats, jobs, backup, now: nowS });
  app.decorate("health", health);
  jobs.start(opts.jobsTickMs ?? 0);
  // The light is looked at as often as the clock; a change goes into the job log (tests call `health.checkAlarm()` themselves).
  const alarmTimer = (opts.jobsTickMs ?? 0) > 0 ? setInterval(() => health.checkAlarm(), opts.jobsTickMs) : undefined;
  alarmTimer?.unref();
  app.addHook("onClose", async () => {
    if (alarmTimer) clearInterval(alarmTimer);
    await jobs.stop();
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
  registerApi(app, { store, session, archive, instruments, search: instrumentSearch(opts.search ?? createYahooSearch(), stats), hub, backfill, longterm, fx, db, backup, jobs, health, now: nowS });

  if (existsSync(WEB_DIST)) {
    app.register(fastifyStatic, { root: WEB_DIST });
  }
  return app;
}
