import type { WebSocket } from "ws";
import { z } from "zod";
import { describeError } from "./errors.js";
import type { SessionService, TickResult } from "./session.js";
import type { Store } from "./store.js";

const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("tempo"), tempo: z.union([z.literal(1), z.literal(5), z.literal(30), z.literal(60)]) }),
]);

/** The longest stretch of real time one tick may account for. */
export const MAX_TICK_MS = 1000;

/** Real time since the last tick: never negative, and a stalled server cannot make time jump. */
export const elapsedMs = (now: number, last: number) => Math.min(Math.max(now - last, 0), MAX_TICK_MS);

interface Loop {
  timer: NodeJS.Timeout;
  last: number;
  busy: boolean;
}

/**
 * The clients of each simulation and the one loop that drives its clock. A loop runs only
 * while a client is connected and the simulation is running; the last client leaving pauses it.
 */
export function createHub(session: SessionService, store: Store, tickMs: number) {
  const clients = new Map<number, Set<WebSocket>>();
  const loops = new Map<number, Loop>();

  const send = (ws: WebSocket, m: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const broadcast = (id: number, m: unknown) => {
    for (const ws of clients.get(id) ?? []) send(ws, m);
  };
  const snapshotMessage = (id: number) => ({ type: "snapshot", ...session.snapshot(id) });

  function stopLoop(id: number) {
    const loop = loops.get(id);
    if (loop) {
      clearInterval(loop.timer);
      loops.delete(id);
    }
    session.pause(id);
  }

  async function step(id: number) {
    const loop = loops.get(id);
    if (!loop || loop.busy) return;
    const now = performance.now(); // monotonic, unlike Date.now()
    const realMs = elapsedMs(now, loop.last);
    loop.last = now;
    loop.busy = true;
    try {
      const result: TickResult = session.tick(id, realMs);
      const { simulation: _simulation, ...rest } = session.snapshot(id);
      broadcast(id, { type: "tick", simulationTime: result.simulationTime, newBars: result.newBars, ...rest });
      if (result.endOfData) {
        const more = await session.loadMore(id);
        loop.last = performance.now(); // the time spent loading is not simulation time
        if (!more) {
          stopLoop(id);
          broadcast(id, { type: "notice", text: "Ende der Daten: für die Zeit danach gibt es noch keine Kurse." });
          broadcast(id, snapshotMessage(id));
        }
      }
    } catch (err) {
      stopLoop(id);
      broadcast(id, { type: "notice", text: describeError(err) });
      broadcast(id, snapshotMessage(id));
    } finally {
      loop.busy = false;
    }
  }

  function startLoop(id: number) {
    if (loops.has(id)) return;
    session.run(id);
    loops.set(id, { timer: setInterval(() => void step(id), tickMs), last: performance.now(), busy: false });
  }

  return {
    attach(ws: WebSocket, id: number) {
      if (!store.getSimulation(id)) {
        send(ws, { type: "error", text: "Unbekannte Simulation." });
        ws.close(1008, "unknown simulation");
        return;
      }
      let set = clients.get(id);
      if (!set) clients.set(id, (set = new Set()));
      set.add(ws);
      send(ws, snapshotMessage(id));

      ws.on("message", (raw) => {
        let parsed: z.infer<typeof message>;
        try {
          parsed = message.parse(JSON.parse(String(raw)));
        } catch {
          send(ws, { type: "error", text: "Die Nachricht wurde nicht verstanden." });
          return;
        }
        if (parsed.type === "tempo") {
          session.setTempo(id, parsed.tempo);
        } else if (parsed.type === "run") {
          if (store.getSimulation(id)?.endedAt != null) {
            send(ws, { type: "notice", text: "Die Simulation ist beendet." });
            return;
          }
          startLoop(id);
        } else {
          stopLoop(id);
        }
        broadcast(id, snapshotMessage(id));
      });

      ws.on("close", () => {
        set.delete(ws);
        if (set.size === 0) {
          clients.delete(id);
          stopLoop(id);
        }
      });
    },

    broadcastSnapshot(id: number) {
      if (clients.has(id)) broadcast(id, snapshotMessage(id));
    },

    /** Stops the clock and closes the clients of a simulation that is being ended or deleted. */
    drop(id: number) {
      stopLoop(id);
      for (const ws of [...(clients.get(id) ?? [])]) ws.close(1000, "simulation removed");
      clients.delete(id);
    },

    stopAll() {
      for (const id of [...loops.keys()]) stopLoop(id);
      for (const set of clients.values()) for (const ws of set) ws.close(1001, "server stopping");
      clients.clear();
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
