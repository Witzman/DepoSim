import type { Instrument, Venue } from "./config.js";
import type { Archive } from "./data/archive.js";
import { type Bar, MarketDataError } from "./data/marketdata.js";
import { type DepotState, type NewOrder, depotValue, fillOrder, positionValue, triggersLimit, validateOrder } from "./domain/broker.js";
import {
  CATCH_UP_LAG_S, LIVE_EDGE_S, LIVE_MARGIN_S, OPEN_WINDOW_S, type Tempo, advanceCarry, effectiveTempo, liveLimit, skipClosed,
} from "./domain/clock.js";
import { type CostPreview, type Ref, previewCost } from "./domain/fees.js";
import type { Cent } from "./domain/money.js";
import type { OrderRecord, Simulation, Store } from "./store.js";

const DAY = 86400;
const LOOKAHEAD_DAYS = 7;
const DEFAULT_DELAY_S = 900;
const DEFAULT_CATCH_UP_TEMPO = 300;
const dayOf = (t: number) => Math.floor(t / DAY) * DAY;

export interface SessionDeps {
  store: Store;
  archive: Archive;
  instruments: Instrument[];
  /** The exchange-rate series. It is read for prices but is not an instrument. */
  fxSymbol: string;
  /** Current time in UTC seconds. */
  now?: () => number;
  /** How far behind the present the price source is. */
  delayS?: number;
  /** The tempo a live simulation catches up at. */
  catchUpTempo?: number;
}

export interface TickResult {
  simulationTime: number;
  /** Bars that finished during this tick, per instrument. The exchange rate is left out. */
  newBars: Record<string, Bar[]>;
  /** No later bar is in the archive. The caller may try `loadMore`. */
  endOfData: boolean;
  /** The clock was held back at the newest known bar, and the present is further on. */
  waitingForData: boolean;
  /** The newest known bar is close to the live limit, so the market is running now. */
  liveEdge: boolean;
}

export interface PositionView {
  symbol: string;
  qty: number;
  cost: Cent;
  value: Cent;
}

export interface Snapshot {
  simulation: Simulation;
  running: boolean;
  depot: { id: number; name: string; cash: Cent; value: Cent; positions: PositionView[]; orders: OrderRecord[] };
  prices: Record<string, { price: number; barT: number }>;
  fx: number | null;
  venues: Record<Venue, boolean>;
  /** The latest simulation time that may be shown: now minus the delay. */
  liveLimit: number;
  delayS: number;
  /** Replay, catching up to the present, or at the present. */
  phase: "replay" | "catchup" | "live";
}

export type PlaceResult = { ok: true; orderId: number } | { ok: false; reason: string };

/** `problem` is why the order would be rejected; the cost is shown anyway. */
export type PreviewResult = { ok: true; cost: CostPreview; problem?: string } | { ok: false; reason: string };

export class SessionService {
  private readonly store: Store;
  private readonly archive: Archive;
  private readonly instruments: Instrument[];
  private readonly bySymbol: Map<string, Instrument>;
  private readonly fx: string;
  private readonly now: () => number;
  private readonly delayS: number;
  private readonly catchUpTempo: number;
  private readonly running = new Set<number>();
  /** The part of a simulated second a short tick left over, per simulation. Lost on a restart, which costs under a second. */
  private readonly carry = new Map<number, number>();

  constructor(deps: SessionDeps) {
    this.store = deps.store;
    this.archive = deps.archive;
    this.instruments = deps.instruments;
    this.bySymbol = new Map(deps.instruments.map((i) => [i.symbol, i]));
    this.fx = deps.fxSymbol;
    this.now = deps.now ?? (() => Date.now() / 1000);
    this.delayS = deps.delayS ?? DEFAULT_DELAY_S;
    this.catchUpTempo = deps.catchUpTempo ?? DEFAULT_CATCH_UP_TEMPO;
  }

  /** Loads the start day of every instrument. Throws, and starts nothing, if there are no prices. */
  async start(id: number): Promise<void> {
    const day = dayOf(this.sim(id).simulationTime);
    await this.loadDay(day);
    const traded = this.instruments.some((i) => this.archive.barsBetween(i.symbol, day, day + DAY).length > 0);
    if (!traded) throw new MarketDataError("no_data", "Für diesen Tag liegen keine Kurse vor.");
  }

  /** Looks for later bars, a day at a time, never past today. True if it found some. */
  async loadMore(id: number): Promise<boolean> {
    const s = this.sim(id).simulationTime;
    for (let d = 0; d <= LOOKAHEAD_DAYS; d++) {
      const day = dayOf(s) + d * DAY;
      if (day > this.now()) break;
      await this.loadDay(day);
      if (this.instruments.some((i) => this.archive.nextBarAfter(i.symbol, s))) return true;
    }
    return false;
  }

  setTempo(id: number, tempo: Tempo): void {
    this.store.setTempo(id, tempo);
  }

  run(id: number): void {
    this.running.add(id);
  }

  pause(id: number): void {
    this.running.delete(id);
  }

  /** Not stored: after a restart every simulation is paused. */
  isRunning(id: number): boolean {
    return this.running.has(id);
  }

  /**
   * Moves the time on and evaluates every bar that finished in between, once, in time order.
   * The fills and the new time are written in one transaction: if anything throws, none of it
   * happened and the same bars are still waiting to be evaluated.
   */
  tick(id: number, realMs: number): TickResult {
    const sim = this.sim(id);
    if (sim.endedAt !== null) {
      return { simulationTime: sim.simulationTime, newBars: {}, endOfData: true, waitingForData: false, liveEdge: false };
    }

    const sOld = sim.simulationTime;
    const symbols = this.instruments.map((i) => i.symbol);

    // The time may not pass now minus the delay (L), and may not pass the newest bar we know
    // (H): a minute whose bar is fetched later would be skipped, and no order would see it.
    const limitL = liveLimit(this.now(), this.delayS);
    const lag = limitL - sOld;
    const tempo = effectiveTempo(sim.live, sim.tempo, lag, this.catchUpTempo);
    let raw: number;
    let carryOut = 0;
    let advanced = false;
    if (sim.live && lag <= CATCH_UP_LAG_S) {
      raw = limitL; // close enough: a live simulation sits on the limit
    } else {
      const step = advanceCarry(sOld, tempo, realMs, this.carry.get(id) ?? 0);
      raw = step.s;
      carryOut = step.carry;
      advanced = true;
    }
    const capped = Math.min(raw, limitL);
    const skipped = skipClosed(capped, symbols, this.archive);
    const endOfData = skipped === undefined;
    const target0 = skipped === undefined ? capped : Math.min(skipped, limitL);

    const horizon = this.horizon();
    const liveEdge = horizon !== undefined && limitL - horizon <= LIVE_EDGE_S;
    const ceiling = horizon === undefined ? sOld : Math.max(sOld, liveEdge ? horizon - LIVE_MARGIN_S : horizon);
    const waitingForData = target0 > ceiling;
    const target = Math.max(sOld, Math.min(target0, ceiling)); // never back, never past the horizon
    this.carry.set(id, advanced && target === raw ? carryOut : 0);

    // A bar that begins at t is finished at t + 60, so the window is sOld < t + 60 <= target.
    const newBars: Record<string, Bar[]> = {};
    const flat: { symbol: string; bar: Bar }[] = [];
    for (const symbol of symbols) {
      const bars = this.archive.barsBetween(symbol, sOld - 59, target - 59);
      if (bars.length > 0) newBars[symbol] = bars;
      for (const bar of bars) flat.push({ symbol, bar });
    }
    flat.sort((a, b) => a.bar.t - b.bar.t || a.symbol.localeCompare(b.symbol));

    this.store.transaction(() => {
      for (const depot of this.store.listDepots(id)) {
        const state = this.store.loadDepot(depot.id);
        let changed = false;
        for (const { symbol, bar } of flat) changed = this.evaluate(state, sim, symbol, bar) || changed;
        if (changed) this.store.saveBalance(depot.id, state.cash, state.positions);
      }
      this.store.setSimulationTime(id, target);
    });

    return { simulationTime: target, newBars, endOfData, waitingForData, liveEdge };
  }

  /** The end of the newest bar of any instrument (the exchange rate is left out), if there is one. */
  private horizon(): number | undefined {
    let h: number | undefined;
    for (const inst of this.instruments) {
      const bar = this.archive.lastCompleteBar(inst.symbol, Number.MAX_SAFE_INTEGER);
      if (bar && (h === undefined || bar.t + 60 > h)) h = bar.t + 60;
    }
    return h;
  }

  placeOrder(id: number, depotId: number, o: NewOrder): PlaceResult {
    const sim = this.sim(id);
    if (sim.endedAt !== null) return { ok: false, reason: "Die Simulation ist beendet." };
    if (!this.store.listDepots(id).some((d) => d.id === depotId)) return { ok: false, reason: "Unbekanntes Depot." };
    const inst = this.bySymbol.get(o.symbol);
    if (!inst) return { ok: false, reason: `Unbekanntes Wertpapier ${o.symbol}.` };

    const s = sim.simulationTime;
    const ref = this.refAt(inst, s);
    return this.store.transaction((): PlaceResult => {
      const state = this.store.loadDepot(depotId);
      const checked = validateOrder(state, o, ref, sim.fees);
      if (!checked.ok) return checked;

      const orderId = this.store.insertOrder(depotId, o, s);
      // A market order fills now if the market is open. Otherwise it waits for the first bar.
      if (o.kind === "market" && ref && this.venueOpen(inst.venue, s)) {
        const order = { ...o, id: orderId, status: "open" as const };
        const exec = previewCost(o.side, o.qty, ref, "market", undefined, sim.fees);
        fillOrder(state, order, exec);
        this.store.saveBalance(depotId, state.cash, state.positions);
        this.store.markFilled(orderId, {
          filledSim: s, fillPrice: exec.execPrice, gross: exec.gross, commission: exec.commission, foreignFee: exec.foreign,
        });
      }
      return { ok: true, orderId };
    });
  }

  /** What the order would cost at the current price, with the same numbers a fill would use. */
  previewOrder(id: number, o: NewOrder): PreviewResult {
    const sim = this.sim(id);
    const inst = this.bySymbol.get(o.symbol);
    if (!inst) return { ok: false, reason: `Unbekanntes Wertpapier ${o.symbol}.` };
    const ref = this.refAt(inst, sim.simulationTime);
    if (!ref) return { ok: false, reason: `Für ${o.symbol} gibt es noch keinen Kurs.` };

    const state = this.store.loadDepot(this.store.listDepots(id)[0].id);
    const checked = validateOrder(state, o, ref, sim.fees);
    const priceable = Number.isInteger(o.qty) && o.qty > 0 && (o.kind === "market" || (o.limitPrice ?? 0) > 0);
    if (!priceable) return { ok: false, reason: checked.ok ? "Ungültiger Auftrag." : checked.reason };
    const cost = previewCost(o.side, o.qty, ref, o.kind, o.limitPrice, sim.fees);
    return checked.ok ? { ok: true, cost } : { ok: true, cost, problem: checked.reason };
  }

  cancelOrder(id: number, orderId: number): { ok: true } | { ok: false; reason: string } {
    for (const depot of this.store.listDepots(id)) {
      const order = this.store.loadDepot(depot.id).orders.find((x) => x.id === orderId);
      if (!order) continue;
      if (order.status !== "open") return { ok: false, reason: "Nur offene Aufträge lassen sich löschen." };
      this.store.setOrderStatus(orderId, "cancelled");
      return { ok: true };
    }
    return { ok: false, reason: "Unbekannter Auftrag." };
  }

  /** Open while one of the market's instruments had a bar finish within OPEN_WINDOW_S. */
  venueOpen(venue: Venue, s: number): boolean {
    return this.instruments
      .filter((i) => i.venue === venue)
      .some((i) => {
        const last = this.archive.lastCompleteBar(i.symbol, s);
        return last !== undefined && s - (last.t + 60) <= OPEN_WINDOW_S;
      });
  }

  snapshot(id: number): Snapshot {
    const simulation = this.sim(id);
    const s = simulation.simulationTime;
    const depot = this.store.listDepots(id)[0];
    const state = this.store.loadDepot(depot.id);

    const prices: Snapshot["prices"] = {};
    const refs = new Map<string, Ref>();
    for (const inst of this.instruments) {
      const bar = this.archive.lastCompleteBar(inst.symbol, s);
      if (!bar) continue;
      prices[inst.symbol] = { price: bar.c, barT: bar.t };
      const ref = this.refAt(inst, s);
      if (ref) refs.set(inst.symbol, ref);
    }

    const limitL = liveLimit(this.now(), this.delayS);
    const lag = limitL - s;
    const phase: Snapshot["phase"] = lag <= CATCH_UP_LAG_S ? "live" : simulation.live ? "catchup" : "replay";

    return {
      simulation,
      running: this.isRunning(id),
      depot: {
        id: depot.id,
        name: depot.name,
        cash: state.cash,
        value: depotValue(state, refs),
        positions: [...state.positions].map(([symbol, pos]) => ({
          symbol, qty: pos.qty, cost: pos.cost, value: positionValue(pos, refs.get(symbol)),
        })),
        orders: state.orders,
      },
      prices,
      fx: this.archive.lastCompleteBar(this.fx, s)?.c ?? null,
      venues: { XETRA: this.venueOpen("XETRA", s), US: this.venueOpen("US", s) },
      liveLimit: limitL,
      delayS: this.delayS,
      phase,
    };
  }

  private sim(id: number): Simulation {
    const sim = this.store.getSimulation(id);
    if (!sim) throw new Error(`unknown simulation ${id}`);
    return sim;
  }

  private async loadDay(dayStartT: number): Promise<void> {
    for (const symbol of [...this.instruments.map((i) => i.symbol), this.fx]) {
      await this.archive.ensureDay(symbol, dayStartT);
    }
  }

  /** The last known price of an instrument, with the exchange rate for USD. */
  private refAt(inst: Instrument, s: number): Ref | undefined {
    const bar = this.archive.lastCompleteBar(inst.symbol, s);
    if (!bar) return undefined;
    if (inst.currency === "EUR") return { price: bar.c, currency: "EUR" };
    const eurUsd = this.archive.lastCompleteBar(this.fx, s)?.c;
    return eurUsd === undefined ? undefined : { price: bar.c, currency: "USD", eurUsd };
  }

  /** Fills what this finished bar triggers. True if the depot changed. */
  private evaluate(state: DepotState & { orders: OrderRecord[] }, sim: Simulation, symbol: string, bar: Bar): boolean {
    const inst = this.bySymbol.get(symbol)!;
    let changed = false;
    for (const o of state.orders) {
      if (o.status !== "open" || o.symbol !== symbol) continue;
      // A market order that was waiting for a price gets the open of the first bar.
      if (o.kind === "limit" && !triggersLimit(o, bar)) continue;

      const price = o.kind === "market" ? bar.o : bar.c;
      let ref: Ref;
      if (inst.currency === "EUR") {
        ref = { price, currency: "EUR" };
      } else {
        const eurUsd = this.archive.lastCompleteBar(this.fx, bar.t + 60)?.c;
        if (eurUsd === undefined) continue; // cannot price it yet, it stays open
        ref = { price, currency: "USD", eurUsd };
      }
      const exec = previewCost(o.side, o.qty, ref, o.kind, o.limitPrice, sim.fees);

      // A buy needs the cash; a sell needs the shares, and its fees may exceed its proceeds.
      const affordable =
        o.side === "buy"
          ? exec.total <= state.cash
          : (state.positions.get(symbol)?.qty ?? 0) >= o.qty && state.cash + exec.total >= 0;
      if (!affordable) {
        o.status = "rejected";
        this.store.setOrderStatus(o.id, "rejected");
        continue;
      }
      fillOrder(state, o, exec);
      this.store.markFilled(o.id, {
        filledSim: bar.t + 60, fillPrice: exec.execPrice, gross: exec.gross, commission: exec.commission, foreignFee: exec.foreign,
      });
      changed = true;
    }
    return changed;
  }
}
