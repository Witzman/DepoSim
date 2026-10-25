import type { WebSocket } from "ws";
import { z } from "zod";
import { describeError } from "./errors.js";
import { PAUSE_REFUSED, TEMPO_REFUSED } from "./domain/rules.js";
import type { SessionService, TickResult } from "./session.js";
import type { Store } from "./store.js";

const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("step") }),
  z.object({ type: z.literal("tempo"), tempo: z.union([z.literal(1), z.literal(5), z.literal(30), z.literal(60)]) }),
]);

/** The longest stretch of real time one tick may account for. */
export const MAX_TICK_MS = 1000;

/** Real time since the last tick: never negative, and a stalled server cannot make time jump. */
export const elapsedMs = (now: number, last: number) => Math.min(Math.max(now - last, 0), MAX_TICK_MS);

/** True when it is time to refresh the prices again; `undefined` means never yet, so now. */
export const shouldRefresh = (nowMs: number, nextAtMs: number | undefined) =>
  nextAtMs === undefined || nowMs >= nextAtMs;

interface Loop {
  timer: NodeJS.Timeout;
  last: number;
  busy: boolean;
}

/**
 * The clients of each simulation and the one loop that drives its clock. A loop runs only
 * while a client is connected and the simulation is running; the last client leaving pauses it.
 */
export function createHub(session: SessionService, store: Store, tickMs: number, liveRefreshS: number) {
  const clients = new Map<number, Set<WebSocket>>();
  const loops = new Map<number, Loop>();
  // When the prices may be fetched again, per simulation. It outlives a pause: pressing Start
  // again and again must not ask the price source again and again.
  const refreshAt = new Map<number, number>();
  // Simulations that were told "waiting for prices" in the current wait, so it is said once.
  const waiting = new Set<number>();

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
    waiting.delete(id);
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
      if (store.getSimulation(id)?.endedAt != null) {
        // A scenario reached its end: the clock stops, the result is the next thing to look at.
        stopLoop(id);
        broadcast(id, { type: "notice", text: "Das Szenario ist zu Ende. Das Ergebnis steht im Dialog." });
        broadcast(id, snapshotMessage(id));
        return;
      }
      if (result.endOfData || result.waitingForData) {
        // The clock cannot go on without newer prices. Look for them, but not oftener than
        // liveRefreshS: 19 calls to the price source for every look.
        let more = false;
        if (shouldRefresh(performance.now(), refreshAt.get(id))) {
          refreshAt.set(id, performance.now() + liveRefreshS * 1000);
          more = await session.loadMore(id);
          loop.last = performance.now(); // the time spent loading is not simulation time
        }
        const closed = more ? undefined : session.closedNotice(id);
        if (closed) {
          // A holiday or a weekend: no prices will come today. Say so, instead of waiting or "end of data".
          stopLoop(id);
          broadcast(id, { type: "notice", text: `${closed}.` });
          broadcast(id, snapshotMessage(id));
        } else if (!more && result.liveEdge) {
          // The market is running and the prices are a little late: wait, do not stop.
          if (!waiting.has(id)) {
            waiting.add(id);
            broadcast(id, { type: "notice", text: "Warte auf neue Kurse …" });
          }
        } else if (!more) {
          stopLoop(id);
          broadcast(id, { type: "notice", text: "Ende der Daten: für die Zeit danach gibt es noch keine Kurse." });
          broadcast(id, snapshotMessage(id));
        }
      } else {
        waiting.delete(id); // it moves again: the next wait is told again
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
          if (store.getSimulation(id)?.live) {
            send(ws, { type: "notice", text: "Im Livebetrieb bestimmt die Uhr das Tempo: erst Aufholen, dann echte Zeit." });
            return;
          }
          const sim = store.getSimulation(id);
          if (sim?.rules.tempoLocked) {
            send(ws, { type: "notice", text: TEMPO_REFUSED });
            return;
          }
          session.setTempo(id, parsed.tempo);
        } else if (parsed.type === "step") {
          const sim = store.getSimulation(id);
          if (sim?.resolution !== "day") {
            send(ws, { type: "notice", text: "Ein Tag weiter gibt es nur in Tageskurs-Simulationen." });
            return;
          }
          if (sim.endedAt !== null) {
            send(ws, { type: "notice", text: "Die Simulation ist beendet." });
            return;
          }
          stopLoop(id);
          const result = session.stepDays(id, 1);
          const { simulation: _s, ...rest } = session.snapshot(id);
          broadcast(id, { type: "tick", simulationTime: result.simulationTime, newBars: result.newBars, ...rest });
          if (store.getSimulation(id)?.endedAt != null) {
            broadcast(id, { type: "notice", text: "Das Szenario ist zu Ende. Das Ergebnis steht im Dialog." });
            broadcast(id, snapshotMessage(id));
          } else if (result.endOfData) broadcast(id, { type: "notice", text: "Ende der Daten: für die Zeit danach gibt es noch keine Kurse." });
        } else if (parsed.type === "run") {
          if (store.getSimulation(id)?.endedAt != null) {
            send(ws, { type: "notice", text: "Die Simulation ist beendet." });
            return;
          }
          startLoop(id);
        } else {
          if (store.getSimulation(id)?.rules.pauseAllowed === false) {
            send(ws, { type: "notice", text: PAUSE_REFUSED });
            return;
          }
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
      refreshAt.delete(id);
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
