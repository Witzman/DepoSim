import type { WebSocket } from "ws";
import { z } from "zod";
import { publicError } from "./errors.js";
import { PAUSE_REFUSED, TEMPO_REFUSED } from "./domain/rules.js";
import type { Bar } from "./data/marketdata.js";
import type { JumpKind } from "./domain/clock.js";
import type { JumpResult, SessionService, TickResult } from "./session.js";
import type { Store } from "./store.js";

const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("step") }),
  z.object({ type: z.literal("tempo"), tempo: z.union([z.literal(1), z.literal(5), z.literal(30), z.literal(60), z.literal(120), z.literal(300)]) }),
  z.object({ type: z.literal("jump"), to: z.enum(["candle", "hour", "close", "open", "day"]), symbol: z.string().max(20).optional() }),
]);

/** The biggest message a client may send (the longest real one is under 100 bytes), and how many in a second. */
export const MAX_SOCKET_MESSAGE = 1024;
const MESSAGES_PER_SECOND = 40;

/** How much simulated time one piece of a jump plays before the event loop gets a turn. */
const JUMP_PIECE_S = 2 * 3600;

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
export function createHub(session: SessionService, store: Store, tickMs: number, liveRefreshS: number, log?: (err: unknown) => void) {
  const clients = new Map<number, Set<WebSocket>>();
  const loops = new Map<number, Loop>();
  // When the prices may be fetched again, per simulation. It outlives a pause: pressing Start
  // again and again must not ask the price source again and again.
  const refreshAt = new Map<number, number>();
  // Simulations that were told "waiting for prices" in the current wait, so it is said once.
  const waiting = new Set<number>();
  // The simulation time at the last tick: a wait is over when the clock moves, not when one tick merely does not flag it.
  const lastTime = new Map<number, number>();

  // The orders of a depot as last sent in a tick. A tick repeats them only when they changed: the full list of a busy
  // depot made every tick (four a second) as big as its whole history. A client that attaches gets them in its snapshot.
  const sentOrders = new Map<string, string>();
  const ordersSignature = (orders: { id: number; status: string; qty: number; limitPrice?: number }[]) => {
    let filled = 0;
    const open: string[] = [];
    for (const o of orders) {
      if (o.status === "filled") filled++;
      else if (o.status === "open") open.push(`${o.id}:${o.qty}:${o.limitPrice ?? ""}`);
    }
    return `${orders.length}|${filled}|${open.join(",")}`;
  };
  /** The snapshot as a tick carries it: without `simulation`, and without the order lists that did not change since the last tick. */
  const tickRest = (id: number) => {
    const { simulation: _simulation, ...rest } = session.snapshot(id);
    const depots = rest.depots.map((d) => {
      const key = `${id}:${d.id}`;
      const signature = ordersSignature(d.orders);
      if (sentOrders.get(key) === signature) {
        const { orders: _orders, ...slim } = d;
        return slim;
      }
      sentOrders.set(key, signature);
      return d;
    });
    return { ...rest, depots };
  };

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
      broadcast(id, { type: "tick", simulationTime: result.simulationTime, newBars: result.newBars, ...tickRest(id) });
      if (store.getSimulation(id)?.endedAt != null) {
        // A scenario reached its end: the clock stops, the result is the next thing to look at.
        stopLoop(id);
        broadcast(id, { type: "notice", text: "Das Szenario ist zu Ende. Das Ergebnis steht im Dialog." });
        broadcast(id, snapshotMessage(id));
        return;
      }
      const prevTime = lastTime.get(id);
      lastTime.set(id, result.simulationTime);
      const pause = session.autoPauseFor(id, result);
      if (pause) {
        stopLoop(id);
        broadcast(id, { type: "paused", rule: pause.rule, reason: pause.reason });
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
        if (result.simulationTime !== prevTime) waiting.delete(id); // it moves again: the next wait is told again
      }
    } catch (err) {
      stopLoop(id);
      log?.(err);
      broadcast(id, { type: "notice", text: publicError(err) });
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

  const hub = {
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
      // The notice goes out once per wait; a client that joins during it would see a standing clock without a reason.
      if (waiting.has(id)) send(ws, { type: "notice", text: "Warte auf neue Kurse …" });

      let windowStart = 0;
      let inWindow = 0;
      ws.on("message", (raw) => {
        const at = performance.now();
        if (at - windowStart >= 1000) { windowStart = at; inWindow = 0; }
        if (++inWindow > MESSAGES_PER_SECOND) {
          if (inWindow === MESSAGES_PER_SECOND + 1) send(ws, { type: "error", text: "Zu viele Nachrichten in kurzer Zeit." });
          return; // a client that floods is not answered; the page sends a handful at most
        }
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
          const set = session.setTempo(id, parsed.tempo);
          if (!set.ok) {
            send(ws, { type: "notice", text: set.reason });
            broadcast(id, snapshotMessage(id));
          }
        } else if (parsed.type === "jump") {
          void hub.jump(id, parsed.to, parsed.symbol).then((r) => {
            if (!r.ok) send(ws, { type: "notice", text: r.reason });
          });
        } else if (parsed.type === "step") {
          const sim = store.getSimulation(id);
          if (sim?.resolution !== "day") {
            // One candle on; a daily simulation below plays one trading day.
            void hub.jump(id, "candle").then((r) => {
              if (!r.ok) send(ws, { type: "notice", text: r.reason });
            });
            return;
          }
          if (sim.endedAt !== null) {
            send(ws, { type: "notice", text: "Die Simulation ist beendet." });
            return;
          }
          stopLoop(id);
          const result = session.stepDays(id, 1);
          broadcast(id, { type: "tick", simulationTime: result.simulationTime, newBars: result.newBars, ...tickRest(id) });
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
        // After a restore or a deletion `clients` may already hold a newer set for this id: that one stays.
        if (set.size === 0 && clients.get(id) === set) {
          clients.delete(id);
          stopLoop(id);
        }
      });
    },

    broadcastSnapshot(id: number) {
      if (clients.has(id)) broadcast(id, snapshotMessage(id));
    },

    /**
     * Stops the clock, plays it to the target of the jump and tells the clients: the new bars as one tick, why the jump ended
     * early if it did, and a snapshot. The clock stands still afterwards.
     */
    async jump(id: number, kind: JumpKind, symbol?: string): Promise<JumpResult | { ok: false; reason: string }> {
      stopLoop(id);
      let r = session.jump(id, kind, symbol, JUMP_PIECE_S);
      if (!r.ok) return r;
      // A long jump is played in pieces, and the loop gets a turn between them: the other clocks and requests do not wait for all of it.
      while (r.stopped === null && r.simulationTime < r.target) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (loops.has(id)) break; // the person pressed Start in between: the running clock goes on from here
        const next = session.playTo(id, r.target, JUMP_PIECE_S);
        const newBars: Record<string, Bar[]> = { ...r.newBars };
        for (const [sym, bars] of Object.entries(next.newBars)) newBars[sym] = [...(newBars[sym] ?? []), ...bars];
        r = { ...next, newBars };
      }
      // The archive holds the days that were loaded so far. Running out of bars on the way is a reason to fetch the next
      // day, as the running clock does, not to stop; only when nothing more comes does the jump end at the data.
      for (let tries = 0; tries < 12 && r.stopped?.rule === "data"; tries++) {
        const more = await session.loadMore(id).catch(() => false);
        if (!more) break;
        const next: JumpResult = kind === "candle" ? (session.jump(id, "candle", symbol) as JumpResult) : session.playTo(id, r.target);
        if (!next.ok) break;
        const newBars: Record<string, Bar[]> = { ...r.newBars };
        for (const [sym, bars] of Object.entries(next.newBars)) newBars[sym] = [...(newBars[sym] ?? []), ...bars];
        r = { ...next, newBars };
        if (kind === "candle" && next.stopped === null) break;
      }
      broadcast(id, { type: "tick", simulationTime: r.simulationTime, newBars: r.newBars, ...tickRest(id) });
      if (r.stopped) {
        if (r.stopped.rule === "end") broadcast(id, { type: "notice", text: "Das Szenario ist zu Ende. Das Ergebnis steht im Dialog." });
        else if (r.stopped.rule === "data") broadcast(id, { type: "notice", text: r.stopped.reason });
        else broadcast(id, { type: "paused", rule: r.stopped.rule, reason: r.stopped.reason });
      }
      broadcast(id, snapshotMessage(id));
      return r;
    },

    /** Stops the clock and closes the clients of a simulation that is being ended or deleted. */
    drop(id: number) {
      stopLoop(id);
      refreshAt.delete(id);
      lastTime.delete(id);
      for (const key of [...sentOrders.keys()]) if (key.startsWith(`${id}:`)) sentOrders.delete(key);
      for (const ws of [...(clients.get(id) ?? [])]) ws.close(1000, "simulation removed");
      clients.delete(id);
    },

    stopAll() {
      for (const id of [...loops.keys()]) stopLoop(id);
      for (const set of clients.values()) for (const ws of set) ws.close(1001, "server stopping");
      clients.clear();
      sentOrders.clear();
    },
  };
  return hub;
}

export type Hub = ReturnType<typeof createHub>;
