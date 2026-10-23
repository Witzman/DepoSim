import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Instrument } from "./config.js";
import type { Archive } from "./data/archive.js";
import { DEFAULT_FEES } from "./domain/fees.js";
import { describeError } from "./errors.js";
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

interface Deps {
  store: Store;
  session: SessionService;
  archive: Archive;
  instruments: Instrument[];
  hub: Hub;
}

const invalid = (reply: FastifyReply, err: z.ZodError) => {
  const issue = err.issues[0];
  const where = issue.path.join(".") || "Anfrage";
  return reply.code(400).send({ error: `Ungültige Eingabe (${where}): ${issue.message}` });
};

export function registerApi(app: FastifyInstance, { store, session, archive, instruments, hub }: Deps) {
  const simulationOf = (params: unknown) => {
    const id = Number((params as { id?: string }).id);
    return Number.isInteger(id) ? store.getSimulation(id) : undefined;
  };
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "Unbekannte Simulation." });

  app.get("/api/watchlist", async () =>
    instruments.map(({ symbol, name, currency, venue }) => ({ symbol, name, currency, venue })),
  );

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
    if (!instruments.some((i) => i.symbol === query.data.symbol)) {
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
