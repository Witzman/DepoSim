import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { type BackupService, BackupError, restoreInto } from "./backup.js";
import { ExchangeError, barsCsv, exportSimulation, importSimulation, ordersCsv, valuesCsv } from "./exchange.js";
import type { Db } from "./db.js";
import { DEFAULT_DAYS, MAX_DAYS, type Backfill } from "./backfill.js";
import { FX_SYMBOL, type Instrument, SOURCELESS_SUFFIXES, VENUES } from "./config.js";
import type { Archive } from "./data/archive.js";
import type { DailyArchive } from "./data/dailyarchive.js";
import { sessionFor } from "./domain/venues.js";
import { BLOCKING_KINDS } from "./domain/quality.js";
import { MarketDataError } from "./data/marketdata.js";
import type { InstrumentSearch } from "./data/search.js";
import { DEFAULT_FEES } from "./domain/fees.js";
import { applyRules, resolveRules } from "./domain/rules.js";
import { describeError } from "./errors.js";
import type { Fx } from "./fx.js";
import type { Health } from "./health.js";
import type { Jobs } from "./jobs.js";
import type { Longterm } from "./longterm.js";
import { type InstrumentRegistry, RegistryError } from "./instruments.js";
import type { SessionService } from "./session.js";
import type { Store } from "./store.js";
import type { Hub } from "./ws.js";

const DEFAULT_START_CASH = 1_000_000;

const createBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    startAt: z.number().int().positive().optional(),
    live: z.boolean().optional(),
    startCash: z.number().int().positive().optional(),
    /** `day`: one step is a trading day, from daily prices (any start since 2019-11); `minute` is the default. */
    resolution: z.enum(["minute", "day"]).optional(),
    preset: z.enum(["relaxed", "realistic", "hardcore"]).optional(),
    /** Single switches on top of the preset. */
    rules: z.object({
      spreadFactor: z.number().min(0.5).max(5).optional(),
      feeFactor: z.number().min(0.5).max(5).optional(),
      pauseAllowed: z.boolean().optional(),
      tempoLocked: z.boolean().optional(),
      allowFork: z.boolean().optional(),
      maxPositions: z.number().int().min(1).max(50).nullable().optional(),
    }).strict().optional(),
  })
  .refine((b) => b.live === true || b.startAt !== undefined, {
    message: "Ohne Livebetrieb braucht die Simulation einen Startzeitpunkt.",
    path: ["startAt"],
  });

const orderBody = z.object({
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  kind: z.enum(["market", "limit"]),
  qty: z.number(),
  limitPrice: z.number().optional(),
  depotId: z.number().int().optional(),
});

const patchBody = z.object({ benchmark: z.string().min(1).nullable() });
const depotName = z.string().trim().min(1).max(40);
const depotBody = z.object({ name: depotName.optional() });
const renameBody = z.object({ name: depotName });
const allocateBody = z.object({
  weights: z.array(z.object({ symbol: z.string().min(1), percent: z.number().positive().max(100) })).min(1).max(20),
  dryRun: z.boolean().optional(),
});

const compareQuery = z.object({ ids: z.string().default("") });
const COMPARE_NOTE = "Jede Kurve reicht bis zur eigenen Simulationszeit; es gibt keine gemeinsame Zeitachse. Werte in Prozent vom ersten Punkt.";

const hintPrefBody = z.object({
  enabled: z.boolean().optional(),
  hidden: z.boolean().optional(),
  levels: z.array(z.number()).max(3).optional(),
}).strict();

const journalQuery = z.object({ depotId: z.coerce.number().int().optional() });
const noteBody = z.object({ text: z.string().max(500, "Die Notiz darf höchstens 500 Zeichen haben.") });
const TRADE_KEY = /^\d{1,12}:\d{1,12}$/;

/** The first day with daily prices (Yahoo, measured). */
const DAILY_FROM_T = Date.parse("2019-11-01T00:00:00Z") / 1000;

/** Trading days of the venue's calendar between the first and the last bar that have no bar. */
function skippedDays(venueId: string, bars: { t: number }[]): number {
  const venue = VENUES.find((v) => v.id === venueId);
  if (!venue || bars.length < 2) return 0;
  const have = new Set(bars.map((b) => new Date(b.t * 1000).toISOString().slice(0, 10)));
  let missing = 0;
  for (let t = bars[0].t; t <= bars[bars.length - 1].t; t += 86400) {
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    if (!have.has(day) && sessionFor(venue, day).trading) missing++;
  }
  return missing;
}

const barsQuery = z.object({
  symbol: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20000).default(500),
});

const searchQuery = z.object({ q: z.string().trim().min(2).max(40) });
const SYMBOL = /^[A-Za-z0-9.^=-]{1,15}$/;
const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS) });
const addBody = z.object({ symbol: z.string() });

interface Deps {
  daily: DailyArchive;
  store: Store;
  session: SessionService;
  archive: Archive;
  instruments: InstrumentRegistry;
  search: InstrumentSearch;
  hub: Hub;
  backfill: Backfill;
  longterm: Longterm;
  fx: Fx;
  db: Db;
  backup: BackupService;
  jobs: Jobs;
  health: Health;
  now: () => number;
}

const archiveExportQuery = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.^=-]{1,15}$/),
  kind: z.enum(["minute", "day"]).default("minute"),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

/** The largest upload (a backup or a simulation file). The archive is not in them, so this is far above any real size. */
const UPLOAD_LIMIT = 100 * 1024 * 1024;

const invalid = (reply: FastifyReply, err: z.ZodError) => {
  const issue = err.issues[0];
  const where = issue.path.join(".") || "Anfrage";
  return reply.code(400).send({ error: `Ungültige Eingabe (${where}): ${issue.message}` });
};

export function registerApi(app: FastifyInstance, { daily, store, session, archive, instruments, search, hub, backfill, longterm, fx, db, backup, jobs, health, now }: Deps) {
  const simulationOf = (params: unknown) => {
    const id = Number((params as { id?: string }).id);
    return Number.isInteger(id) ? store.getSimulation(id) : undefined;
  };
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "Unbekannte Simulation." });

  app.get("/api/venues", async () =>
    VENUES.map((v) => ({
      id: v.id, name: v.name, timeZone: v.timeZone, opens: v.opens, closes: v.closes, hasSource: v.hasSource, note: v.note,
    })));

  app.get("/api/archive/missing", async (req, reply) => {
    const query = daysQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    return backfill.missing(query.data.days);
  });

  // A background job: it can take minutes (one call every 500 ms), longer than a proxy waits.
  app.post("/api/archive/backfill", async (req, reply) => {
    const body = daysQuery.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const result = backfill.start(body.data.days);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return reply.code(202).send(result.job);
  });

  app.get("/api/archive/backfill", async () => backfill.status());

  // Wechselkurse (#51): the ECB reference rates, one per day. Without `from` the last 90 days.
  // The scheduler (#48): what is planned, what ran. A hand start answers at once; the run goes on in the background.
  app.get("/api/jobs", async () => ({ enabled: jobs.enabled, jobs: jobs.list(), runs: jobs.runs(30) }));
  app.post("/api/jobs/:name/run", async (req, reply) => {
    const result = jobs.run((req.params as { name: string }).name);
    if (!result.ok) return reply.code(result.code).send({ error: result.reason });
    return reply.code(202).send({ queued: true });
  });

  app.get("/api/fx", async (req, reply) => {
    const q = req.query as { ccy?: string; from?: string; to?: string };
    const ccy = (q.ccy ?? "USD").toUpperCase();
    const isDay = (v: string | undefined) => v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!/^[A-Z]{3}$/.test(ccy) || !isDay(q.from) || !isDay(q.to)) return reply.code(400).send({ error: "ccy muss ein Währungscode sein, from und to ein Tag (JJJJ-MM-TT)." });
    const status = fx.status();
    if (!status.currencies.includes(ccy)) return reply.code(404).send({ error: `Für ${ccy} sind keine Wechselkurse gespeichert.`, latestDay: status.latestDay, currencies: status.currencies });
    const latest = fx.latest(ccy)!;
    const from = q.from ?? new Date(Date.parse(`${latest.day}T00:00:00Z`) - 90 * 86400_000).toISOString().slice(0, 10);
    return {
      ccy, from, to: q.to ?? latest.day, rows: fx.rows(ccy, from, q.to),
      latest, latestDay: status.latestDay, fetchedAt: status.fetchedAt, fetchError: status.error, currencies: status.currencies,
      source: "Europäische Zentralbank, Euro-Referenzkurse (keine Handelskurse), je Tag um etwa 16:00 Frankfurt",
    };
  });

  // Langzeitvergleich (#19): computed from stored daily data on every request, nothing kept in memory.
  app.get("/api/longterm", async () => longterm.compute());
  app.post("/api/longterm/refresh", async (_req, reply) => {
    const result = longterm.start();
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return reply.code(202).send(result.job);
  });
  app.get("/api/longterm/refresh", async () => longterm.status());

  // Datenzustand (#49): what the archive holds, how the sources answer, the light for the status line.
  const coverageQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
  const gapsQuery = z.object({ symbol: z.string().regex(SYMBOL), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
  app.get("/api/data/status", async () => health.status());
  app.get("/api/data/coverage", async (req, reply) => {
    const query = coverageQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    return health.coverage(query.data.days);
  });
  app.get("/api/data/gaps", async (req, reply) => {
    const query = gapsQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    const report = health.gaps(query.data.symbol, query.data.day);
    if (!report) return reply.code(404).send({ error: "Unbekanntes Symbol oder ungültiger Tag." });
    return report;
  });
  app.get("/api/data/source", async () => ({ sources: health.sources() }));
  app.get("/api/data/flags", async (req, reply) => {
    const q = z.object({ symbol: z.string().min(1).optional(), from: z.coerce.number().int().min(0).optional() }).safeParse(req.query);
    if (!q.success) return invalid(reply, q.error);
    return health.flags(q.data);
  });
  app.get("/api/data/archive", async () => health.archive());

  // ---- Sicherung, Export, Import (#46) ----
  let restoring = false;
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: UPLOAD_LIMIT }, (_req, body, done) => done(null, body));
  const stamp = () => new Date(now() * 1000).toISOString().slice(0, 10);
  const attachment = (reply: FastifyReply, type: string, name: string) =>
    reply.header("content-type", type).header("content-disposition", `attachment; filename="${name}"`).header("cache-control", "no-store");

  app.get("/api/backup/status", async () => backup.status());

  app.get("/api/backup", async (_req, reply) => {
    try {
      const { name, data } = await backup.snapshot();
      return attachment(reply, "application/vnd.sqlite3", name).send(data);
    } catch (err) {
      return reply.code(500).send({ error: `Die Sicherung ist fehlgeschlagen: ${describeError(err)}` });
    }
  });

  app.post("/api/backup/restore", { bodyLimit: UPLOAD_LIMIT }, async (req, reply) => {
    if ((req.query as { confirm?: string }).confirm !== "ja") {
      return reply.code(400).send({ error: "Das Wiederherstellen ersetzt alle Simulationen und braucht eine Bestätigung." });
    }
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: "Es fehlt die Sicherungsdatei (Inhaltstyp application/octet-stream)." });
    const busy = backfill.status().running ? "Es läuft ein Nachladen." : longterm.status().running ? "Es läuft das Laden der Tagesdaten." : restoring ? "Es läuft schon eine Wiederherstellung." : null;
    if (busy) return reply.code(409).send({ error: `${busy} Bitte warten, dann erneut versuchen.` });
    restoring = true;
    try {
      // The file is checked first; only a good one costs the running clocks and gets a safety backup of the current state.
      let before = "";
      const result = await restoreInto(db, req.body, async () => {
        try {
          before = await backup.preRestore();
        } catch (err) {
          throw new BackupError(`Der aktuelle Stand konnte nicht gesichert werden: ${describeError(err)}`);
        }
        hub.stopAll();
        session.reset();
      });
      return { ...result, savedBefore: before };
    } catch (err) {
      if (err instanceof BackupError) return reply.code(400).send({ error: `${err.message} Nichts wurde geändert.` });
      throw err;
    } finally {
      restoring = false;
    }
  });

  app.post("/api/simulations/import", { bodyLimit: UPLOAD_LIMIT }, async (req, reply) => {
    try {
      const made = importSimulation(db, req.body, (symbol) => instruments.get(symbol) !== undefined, now());
      return reply.code(201).send(store.getSimulation(made.id));
    } catch (err) {
      if (err instanceof ExchangeError) return reply.code(400).send({ error: `${err.message} Nichts wurde geändert.` });
      throw err;
    }
  });

  app.get("/api/archive/export.csv", async (req, reply) => {
    const query = archiveExportQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    const { symbol, kind, from, to } = query.data;
    if (to <= from) return reply.code(400).send({ error: "Das Ende muss nach dem Anfang liegen." });
    return attachment(reply, "text/csv; charset=utf-8", `kurse-${symbol}-${kind === "minute" ? "minuten" : "tage"}.csv`).send(barsCsv(db, symbol, kind, from, to));
  });

  app.get("/api/watchlist", async () => instruments.list().map(shown));

  /** A rate limit of a source is 429, any other failure of it is 502. */
  const sourceFailed = (reply: FastifyReply, err: unknown) =>
    reply.code(err instanceof MarketDataError && err.kind === "rate_limited" ? 429 : 502).send({ error: describeError(err) });
  const shown = (i: Instrument) => ({
    symbol: i.symbol, name: i.name, currency: i.currency, venue: i.venue, added: instruments.isAdded(i.symbol),
  });

  /** The prices of a changed list reach the clients now, not at the next tick (the clock may stand). */
  const refreshClients = () => {
    for (const sim of store.listSimulations()) if (sim.endedAt === null) hub.broadcastSnapshot(sim.id);
  };

  app.get("/api/search", async (req, reply) => {
    const query = searchQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    try {
      const hits = await search.search(query.data.q);
      return hits.map((h) => ({ ...h, known: instruments.get(h.symbol) !== undefined }));
    } catch (err) {
      return sourceFailed(reply, err);
    }
  });

  app.post("/api/watchlist", async (req, reply) => {
    const body = addBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const wanted = body.data.symbol;
    // The registry refuses the exchange rate too; asking here first saves a call to the search.
    if (!SYMBOL.test(wanted) || wanted.toUpperCase() === FX_SYMBOL) {
      return reply.code(400).send({ error: "Ungültiges Kürzel." });
    }
    const sourceless = Object.keys(SOURCELESS_SUFFIXES).find((x) => wanted.toUpperCase().endsWith(x));
    if (sourceless) {
      const venue = VENUES.find((v) => v.id === SOURCELESS_SUFFIXES[sourceless])!;
      return reply.code(400).send({ error: `${venue.name} hat keine Kursquelle und ist nicht handelbar. ${venue.note}` });
    }
    let hit;
    try {
      hit = (await search.search(wanted)).find((h) => h.symbol.toUpperCase() === wanted.toUpperCase());
    } catch (err) {
      return sourceFailed(reply, err);
    }
    if (!hit) return reply.code(404).send({ error: `Unbekanntes Wertpapier ${wanted}.` });

    const known = instruments.get(hit.symbol);
    if (known) return reply.code(200).send(shown(known));

    const inst: Instrument = {
      symbol: hit.symbol, name: hit.name, currency: hit.currency, venue: hit.venue, kind: hit.kind,
      ...(hit.sector ? { sector: hit.sector } : {}),
    };
    try {
      instruments.add(inst);
    } catch (err) {
      if (err instanceof RegistryError) return reply.code(err.kind === "full" ? 409 : 400).send({ error: err.message });
      throw err;
    }
    try {
      await session.prepareInstrument(inst);
    } catch (err) {
      instruments.remove(inst.symbol); // nothing was shown yet, so it is as if it had not been added
      return sourceFailed(reply, err);
    }
    jobs.warmUp(); // the nightly gap repair, started now: the new value gets its 29 days at once
    refreshClients();
    return reply.code(201).send(shown(inst));
  });

  app.delete("/api/watchlist/:symbol", async (req, reply) => {
    const wanted = (req.params as { symbol: string }).symbol;
    const inst = instruments.list().find((i) => i.symbol.toUpperCase() === wanted.toUpperCase());
    if (!inst) return reply.code(404).send({ error: `Unbekanntes Wertpapier ${wanted}.` });
    if (!instruments.isAdded(inst.symbol)) {
      return reply.code(409).send({ error: "Dieses Wertpapier gehört zum Startbestand." });
    }
    if (store.listSimulations().some((s) => s.benchmark === inst.symbol)) {
      return reply.code(409).send({ error: "Das Wertpapier ist als Maßstab gewählt." });
    }
    if (store.symbolInUse(inst.symbol)) {
      return reply.code(409).send({ error: "Das Wertpapier wird gehalten oder hat offene Orders." });
    }
    instruments.remove(inst.symbol);
    refreshClients();
    return reply.code(204).send();
  });

  app.get("/api/simulations", async () => store.listSimulations());

  app.post("/api/simulations", async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    let startAt = body.data.startAt;
    const daily = body.data.resolution === "day";
    if (daily && body.data.live) return reply.code(400).send({ error: "Eine Tageskurs-Simulation kennt keinen Livebetrieb." });
    if (daily && startAt !== undefined) {
      startAt = Math.floor(startAt / 86400) * 86400; // a day starts at midnight UTC
      if (startAt < DAILY_FROM_T) return reply.code(400).send({ error: "Tageskurse gibt es ab dem 1. November 2019." });
      if (startAt >= Math.floor(session.currentLiveLimit() / 86400) * 86400) {
        return reply.code(400).send({ error: "Der Starttag muss vor dem letzten abgeschlossenen Handelstag liegen." });
      }
    }
    if (!daily && startAt !== undefined && startAt > session.currentLiveLimit()) {
      return reply.code(400).send({ error: "Der Startzeitpunkt liegt nach der Live-Grenze (jetzt minus Zeitversatz)." });
    }
    if (startAt === undefined) {
      try {
        startAt = await session.resolveLiveStart();
      } catch (err) {
        return reply.code(502).send({ error: describeError(err) });
      }
    }
    const rules = resolveRules(body.data.preset, body.data.rules);
    const sim = store.createSimulation({
      name: body.data.name,
      startAt,
      startCash: body.data.startCash ?? DEFAULT_START_CASH,
      fees: applyRules(DEFAULT_FEES, rules),
      live: body.data.live === true,
      rules,
      resolution: daily ? "day" : "minute",
    });
    try {
      await session.start(sim.id);
    } catch (err) {
      store.deleteSimulation(sim.id);
      return reply.code(502).send({ error: describeError(err) });
    }
    return reply.code(201).send(store.getSimulation(sim.id));
  });

  app.delete("/api/simulations/:id", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    hub.drop(sim.id);
    store.deleteSimulation(sim.id);
    return reply.code(204).send();
  });

  app.post("/api/simulations/:id/end", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    hub.drop(sim.id);
    store.endSimulation(sim.id);
    return store.getSimulation(sim.id);
  });

  // A static route: it wins over `/api/simulations/:id/...` in the router.
  app.get("/api/simulations/compare", async (req, reply) => {
    const query = compareQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    const parts = query.data.ids.split(",").map((x) => x.trim());
    if (parts.some((x) => !/^\d{1,12}$/.test(x))) return reply.code(400).send({ error: "Die Liste ids braucht Simulationsnummern, durch Komma getrennt." });
    const ids = [...new Set(parts.map(Number))];
    if (ids.length < 2 || ids.length > 4) return reply.code(400).send({ error: "Der Vergleich braucht 2 bis 4 verschiedene Simulationen." });
    const unknown = ids.find((id) => !store.getSimulation(id));
    if (unknown !== undefined) return reply.code(404).send({ error: `Unbekannte Simulation ${unknown}.` });
    return { simulations: ids.map((id) => session.compare(id)), note: COMPARE_NOTE };
  });

  app.get("/api/simulations/:id/export", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    return attachment(reply, "application/json; charset=utf-8", `simulation-${sim.id}-${stamp()}.json`).send(JSON.stringify(exportSimulation(db, sim.id, now())));
  });

  app.get("/api/simulations/:id/orders.csv", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    return attachment(reply, "text/csv; charset=utf-8", `simulation-${sim.id}-orders.csv`).send(ordersCsv(db, sim.id));
  });

  app.get("/api/simulations/:id/values.csv", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    return attachment(reply, "text/csv; charset=utf-8", `simulation-${sim.id}-depotwerte.csv`).send(valuesCsv(db, sim.id));
  });

  app.get("/api/simulations/:id/bars", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const query = barsQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    if (!instruments.get(query.data.symbol)) {
      return reply.code(400).send({ error: `Unbekanntes Wertpapier ${query.data.symbol}.` });
    }
    if (sim.resolution === "day") {
      // Only days that are over at the simulation time: nothing of the future. Days the venue was open but
      // the source has no price for are counted, not invented.
      const all = daily.between(query.data.symbol, 0, sim.simulationTime);
      const bars = all.slice(-query.data.limit);
      return { symbol: query.data.symbol, bars, skipped: skippedDays(instruments.get(query.data.symbol)!.venue, bars) };
    }
    // Bars marked as outliers (#50) go out with `flagged`, so the chart can draw them hollow.
    const bars = archive.barsBefore(query.data.symbol, sim.simulationTime, query.data.limit);
    const marked = bars.length
      ? new Set(archive.flagsBetween(query.data.symbol, bars[0].t, bars[bars.length - 1].t + 1, BLOCKING_KINDS).map((f) => f.t))
      : new Set<number>();
    return {
      symbol: query.data.symbol,
      bars: marked.size ? bars.map((b) => (marked.has(b.t) ? { ...b, flagged: true } : b)) : bars,
    };
  });

  app.get("/api/simulations/:id/orderbook", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const query = z.object({ symbol: z.string().min(1) }).safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    const book = session.orderbook(sim.id, query.data.symbol);
    if (!book) return reply.code(400).send({ error: `Unbekanntes Wertpapier ${query.data.symbol}.` });
    return book;
  });

  app.post("/api/simulations/:id/orders/preview", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const body = orderBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const { depotId, ...order } = body.data;
    if (depotId !== undefined && !store.listDepots(sim.id).some((d) => d.id === depotId)) {
      return reply.code(400).send({ error: "Unbekanntes Depot." });
    }
    const result = session.previewOrder(sim.id, order, depotId);
    if (!result.ok) return reply.code(400).send({ error: result.reason });
    return { cost: result.cost, problem: result.problem, notes: result.notes };
  });

  app.post("/api/simulations/:id/orders", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const body = orderBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const { depotId, ...order } = body.data;
    const result = session.placeOrder(sim.id, depotId ?? session.defaultDepotId(sim.id), order);
    if (!result.ok) return reply.code(400).send({ error: result.reason });
    hub.broadcastSnapshot(sim.id);
    return reply.code(201).send({ orderId: result.orderId });
  });

  const depotOf = (sim: { id: number }, params: unknown) => {
    const depotId = Number((params as { depotId?: string }).depotId);
    return store.listDepots(sim.id).find((d) => d.id === depotId);
  };
  const unknownDepot = (reply: FastifyReply) => reply.code(404).send({ error: "Unbekanntes Depot." });

  app.get("/api/simulations/:id/curves", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    return session.curves(sim.id);
  });

  app.get("/api/simulations/:id/evaluation", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    return session.evaluation(sim.id);
  });

  app.get("/api/simulations/:id/hints", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const query = journalQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    const result = session.hints(sim.id, query.data.depotId ?? session.defaultDepotId(sim.id));
    return result ?? reply.code(404).send({ error: "Unbekanntes Depot." });
  });

  app.put("/api/simulations/:id/hints/:rule", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const body = hintPrefBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const done = session.setHintPref(sim.id, (req.params as { rule: string }).rule, body.data);
    return done.ok ? reply.code(204).send() : reply.code(400).send({ error: done.reason });
  });

  app.get("/api/simulations/:id/journal", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const query = journalQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    const depots = store.listDepots(sim.id);
    const depot = query.data.depotId === undefined ? depots.find((d) => d.id === session.defaultDepotId(sim.id)) : depots.find((d) => d.id === query.data.depotId);
    if (!depot) return unknownDepot(reply);
    if (depot.kind === "ghost") return reply.code(400).send({ error: "Ein Geisterdepot hat kein Journal." });
    return session.journal(sim.id, depot.id);
  });

  app.put("/api/simulations/:id/journal/:tradeKey", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const body = noteBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const tradeKey = (req.params as { tradeKey: string }).tradeKey;
    if (!TRADE_KEY.test(tradeKey) || !session.hasTrade(sim.id, tradeKey)) {
      return reply.code(404).send({ error: "Unbekannter Trade." });
    }
    const text = body.data.text.trim();
    store.setNote(sim.id, tradeKey, text, Math.floor(Date.now() / 1000));
    return { tradeKey, text };
  });

  app.patch("/api/simulations/:id", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const body = patchBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const symbol = body.data.benchmark;
    if (symbol !== null && !instruments.get(symbol)) {
      return reply.code(400).send({ error: `Unbekanntes Wertpapier ${symbol}.` });
    }
    store.setBenchmark(sim.id, symbol);
    hub.broadcastSnapshot(sim.id);
    return store.getSimulation(sim.id);
  });

  app.post("/api/simulations/:id/depots", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const body = depotBody.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const result = session.addDepot(sim.id, body.data.name);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    hub.broadcastSnapshot(sim.id);
    return reply.code(201).send(result.depot);
  });

  app.patch("/api/simulations/:id/depots/:depotId", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const depot = depotOf(sim, req.params);
    if (!depot) return unknownDepot(reply);
    const body = renameBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    store.renameDepot(depot.id, body.data.name);
    hub.broadcastSnapshot(sim.id);
    return { ...depot, name: body.data.name };
  });

  app.post("/api/simulations/:id/depots/:depotId/ghost", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const depot = depotOf(sim, req.params);
    if (!depot) return unknownDepot(reply);
    const result = session.ghostDepot(sim.id, depot.id);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    hub.broadcastSnapshot(sim.id);
    return reply.code(201).send(result.depot);
  });

  app.delete("/api/simulations/:id/depots/:depotId", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const depot = depotOf(sim, req.params);
    if (!depot) return unknownDepot(reply);
    const result = session.removeDepot(sim.id, depot.id);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    hub.broadcastSnapshot(sim.id);
    return reply.code(204).send();
  });

  app.post("/api/simulations/:id/depots/:depotId/allocate", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const depot = depotOf(sim, req.params);
    if (!depot) return unknownDepot(reply);
    const body = allocateBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const dryRun = body.data.dryRun === true;
    const result = session.allocate(sim.id, depot.id, body.data.weights, dryRun);
    if (!result.ok) return reply.code(400).send({ error: result.reason });
    if (!dryRun) hub.broadcastSnapshot(sim.id);
    return { lines: result.lines };
  });

  app.delete("/api/simulations/:id/orders/:orderId", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const orderId = Number((req.params as { orderId: string }).orderId);
    if (!Number.isInteger(orderId)) return reply.code(400).send({ error: "Ungültige Auftragsnummer." });
    const result = session.cancelOrder(sim.id, orderId);
    if (!result.ok) return reply.code(400).send({ error: result.reason });
    hub.broadcastSnapshot(sim.id);
    return reply.code(204).send();
  });
}
