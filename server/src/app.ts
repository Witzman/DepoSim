import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerApi } from "./api.js";
import { FX_SYMBOL, type Instrument, WATCHLIST } from "./config.js";
import { createArchive } from "./data/archive.js";
import type { MarketData } from "./data/marketdata.js";
import { type InstrumentSearch, createYahooSearch } from "./data/search.js";
import { createYahoo } from "./data/yahoo.js";
import { openDb } from "./db.js";
import { InstrumentRegistry } from "./instruments.js";
import { SessionService } from "./session.js";
import { createStore } from "./store.js";
import { createHub } from "./ws.js";

export interface AppOptions {
  dbPath: string;
  /** The price source. Defaults to Yahoo. */
  marketData?: MarketData;
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
}

declare module "fastify" {
  interface FastifyInstance {
    session: SessionService;
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
  const hub = createHub(session, store, opts.tickMs ?? 250, opts.liveRefreshS ?? 60);

  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.decorate("session", session);
  app.addHook("onClose", async () => {
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
  registerApi(app, { store, session, archive, instruments, search: opts.search ?? createYahooSearch(), hub });

  if (existsSync(WEB_DIST)) {
    app.register(fastifyStatic, { root: WEB_DIST });
  }
  return app;
}
