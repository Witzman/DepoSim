import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { FX_SYMBOL, type Instrument } from "./config.js";
import type { Archive } from "./data/archive.js";
import { MarketDataError } from "./data/marketdata.js";
import type { InstrumentSearch } from "./data/search.js";
import { DEFAULT_FEES } from "./domain/fees.js";
import { describeError } from "./errors.js";
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
});

const barsQuery = z.object({
  symbol: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

const searchQuery = z.object({ q: z.string().trim().min(2).max(40) });
const SYMBOL = /^[A-Za-z0-9.^=-]{1,15}$/;
const addBody = z.object({ symbol: z.string() });

interface Deps {
  store: Store;
  session: SessionService;
  archive: Archive;
  instruments: InstrumentRegistry;
  search: InstrumentSearch;
  hub: Hub;
}

const invalid = (reply: FastifyReply, err: z.ZodError) => {
  const issue = err.issues[0];
  const where = issue.path.join(".") || "Anfrage";
  return reply.code(400).send({ error: `Ungültige Eingabe (${where}): ${issue.message}` });
};

export function registerApi(app: FastifyInstance, { store, session, archive, instruments, search, hub }: Deps) {
  const simulationOf = (params: unknown) => {
    const id = Number((params as { id?: string }).id);
    return Number.isInteger(id) ? store.getSimulation(id) : undefined;
  };
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "Unbekannte Simulation." });

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
    let hit;
    try {
      hit = (await search.search(wanted)).find((h) => h.symbol.toUpperCase() === wanted.toUpperCase());
    } catch (err) {
      return sourceFailed(reply, err);
    }
    if (!hit) return reply.code(404).send({ error: `Unbekanntes Wertpapier ${wanted}.` });

    const known = instruments.get(hit.symbol);
    if (known) return reply.code(200).send(shown(known));

    const inst: Instrument = { symbol: hit.symbol, name: hit.name, currency: hit.currency, venue: hit.venue };
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
    if (startAt !== undefined && startAt > session.currentLiveLimit()) {
      return reply.code(400).send({ error: "Der Startzeitpunkt liegt nach der Live-Grenze (jetzt minus Zeitversatz)." });
    }
    if (startAt === undefined) {
      try {
        startAt = await session.resolveLiveStart();
      } catch (err) {
        return reply.code(502).send({ error: describeError(err) });
      }
    }
    const sim = store.createSimulation({
      name: body.data.name,
      startAt,
      startCash: body.data.startCash ?? DEFAULT_START_CASH,
      fees: DEFAULT_FEES,
      live: body.data.live === true,
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

  app.get("/api/simulations/:id/bars", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const query = barsQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error);
    if (!instruments.get(query.data.symbol)) {
      return reply.code(400).send({ error: `Unbekanntes Wertpapier ${query.data.symbol}.` });
    }
    return {
      symbol: query.data.symbol,
      bars: archive.barsBefore(query.data.symbol, sim.simulationTime, query.data.limit),
    };
  });

  app.post("/api/simulations/:id/orders/preview", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const body = orderBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const result = session.previewOrder(sim.id, body.data);
    if (!result.ok) return reply.code(400).send({ error: result.reason });
    return { cost: result.cost, problem: result.problem };
  });

  app.post("/api/simulations/:id/orders", async (req, reply) => {
    const sim = simulationOf(req.params);
    if (!sim) return notFound(reply);
    const body = orderBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const result = session.placeOrder(sim.id, store.listDepots(sim.id)[0].id, body.data);
    if (!result.ok) return reply.code(400).send({ error: result.reason });
    hub.broadcastSnapshot(sim.id);
    return reply.code(201).send({ orderId: result.orderId });
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
