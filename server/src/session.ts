import { type Instrument, MAX_DEPOTS, type Venue } from "./config.js";
import type { InstrumentRegistry } from "./instruments.js";
import type { Archive } from "./data/archive.js";
import { type Bar, MarketDataError } from "./data/marketdata.js";
import { type DepotState, type NewOrder, depotValue, fillOrder, positionValue, triggersLimit, validateOrder } from "./domain/broker.js";
import {
  CATCH_UP_LAG_S, LIVE_EDGE_S, LIVE_MARGIN_S, OPEN_WINDOW_S, type Tempo, advanceCarry, effectiveTempo, liveLimit, skipClosed,
} from "./domain/clock.js";
import { type AllocationLine, planAllocation } from "./domain/allocation.js";
import { type CostPreview, type Ref, previewCost } from "./domain/fees.js";
import type { Cent } from "./domain/money.js";
import type { Depot, OrderRecord, Simulation, Store } from "./store.js";

const DAY = 86400;
const LOOKAHEAD_DAYS = 7;
const DEFAULT_DELAY_S = 900;
const DEFAULT_CATCH_UP_TEMPO = 300;
const dayOf = (t: number) => Math.floor(t / DAY) * DAY;

export interface SessionDeps {
  store: Store;
  archive: Archive;
  instruments: InstrumentRegistry;
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

export interface DepotSnapshot {
  id: number;
  name: string;
  cash: Cent;
  value: Cent;
  positions: PositionView[];
  orders: OrderRecord[];
}

export interface Snapshot {
  simulation: Simulation;
  running: boolean;
  /** Every depot of the simulation, in the order they were made. */
  depots: DepotSnapshot[];
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
  private readonly registry: InstrumentRegistry;
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
    this.registry = deps.instruments;
    this.fx = deps.fxSymbol;
    this.now = deps.now ?? (() => Date.now() / 1000);
    this.delayS = deps.delayS ?? DEFAULT_DELAY_S;
    this.catchUpTempo = deps.catchUpTempo ?? DEFAULT_CATCH_UP_TEMPO;
  }

  /** The tradable instruments right now. The list can grow while the service runs, so it is read on every use. */
  private get instruments(): Instrument[] {
    return this.registry.list();
  }

  /** Loads the start day of every instrument. Throws, and starts nothing, if there are no prices. */
  async start(id: number): Promise<void> {
    const day = dayOf(this.sim(id).simulationTime);
    await this.loadDay(day);
    const traded = this.instruments.some((i) => this.archive.barsBetween(i.symbol, day, day + DAY).length > 0);
    if (!traded) throw new MarketDataError("no_data", "Für diesen Tag liegen keine Kurse vor.");
  }

  /**
   * Fetches what a new instrument needs to show up: for every simulation that has not ended, the day
   * of its clock and the three days before it (three calendar days reach back over a weekend). A day
   * without trading is not an error. A rate limit or a network failure is passed on.
   */
  async prepareInstrument(inst: Instrument): Promise<void> {
    const days = new Set<number>();
    for (const sim of this.store.listSimulations()) {
      if (sim.endedAt !== null) continue;
      for (let k = 0; k <= 3; k++) days.add(dayOf(sim.simulationTime) - k * DAY);
    }
    for (const day of [...days].sort((a, b) => b - a)) await this.archive.ensureDay(inst.symbol, day);
  }

  /** The latest simulation time that may be shown now: the present minus the delay of the source. */
  currentLiveLimit(): number {
    return liveLimit(this.now(), this.delayS);
  }

  /**
   * Where a live simulation starts when none is asked for: the present (the live limit), or, when
   * the market is shut, the end of the newest bar, which can be days back. Walks back from the
   * day of the live limit, at most eight days, loading each.
   */
  async resolveLiveStart(): Promise<number> {
    const limit = this.currentLiveLimit();
    for (let d = 0; d <= LOOKAHEAD_DAYS; d++) {
      const day = dayOf(limit) - d * DAY;
      await this.loadDay(day);
      const bound = d === 0 ? limit : day + DAY;
      let newest: number | undefined;
      for (const inst of this.instruments) {
        const bar = this.archive.lastCompleteBar(inst.symbol, bound);
        if (bar && bar.t >= day && (newest === undefined || bar.t + 60 > newest)) newest = bar.t + 60;
      }
      if (newest !== undefined) return Math.min(limit, newest);
    }
    throw new MarketDataError("no_data", "Für die letzten Handelstage liegen keine Kurse vor.");
  }

  /**
   * Looks for later bars, a day at a time, never past today. True if it found some: a bar that
   * is not finished at `s` yet (`t + 60 > s`). Counting only bars that start after `s` missed
   * the first new minute when the clock stands exactly at the end of the last bar.
   */
  async loadMore(id: number): Promise<boolean> {
    const s = this.sim(id).simulationTime;
    for (let d = 0; d <= LOOKAHEAD_DAYS; d++) {
      const day = dayOf(s) + d * DAY;
      if (day > this.now()) break;
      await this.loadDay(day);
      if (this.instruments.some((i) => this.archive.nextBarAfter(i.symbol, s - 60))) return true;
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
      // One curve point per depot whenever the clock passes a minute boundary.
      if (Math.floor(target / 60) > Math.floor(sOld / 60)) {
        for (const depot of this.store.listDepots(id)) {
          this.store.recordValue(depot.id, target, depotValue(this.store.loadDepot(depot.id), this.refsAt(target)));
        }
      }
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
    const inst = this.registry.get(o.symbol);
    if (!inst) return { ok: false, reason: `Unbekanntes Wertpapier ${o.symbol}.` };

    const s = sim.simulationTime;
    const ref = this.refAt(inst, s);
    // No price now and no bar to come in the archive (an instrument added later, or one the source
    // does not know): the order would wait for good, and an open order blocks removing the
    // instrument. An order before the first bar of the day is different: that bar is known.
    if (!ref && !this.archive.nextBarAfter(o.symbol, s - 60)) {
      return { ok: false, reason: `Für ${o.symbol} gibt es noch keinen Kurs.` };
    }
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
  previewOrder(id: number, o: NewOrder, depotId?: number): PreviewResult {
    const sim = this.sim(id);
    const inst = this.registry.get(o.symbol);
    if (!inst) return { ok: false, reason: `Unbekanntes Wertpapier ${o.symbol}.` };
    const ref = this.refAt(inst, sim.simulationTime);
    if (!ref) return { ok: false, reason: `Für ${o.symbol} gibt es noch keinen Kurs.` };

    const depot = this.store.listDepots(id).find((d) => d.id === depotId) ?? this.store.listDepots(id)[0];
    const state = this.store.loadDepot(depot.id);
    const checked = validateOrder(state, o, ref, sim.fees);
    const priceable = Number.isInteger(o.qty) && o.qty > 0 && (o.kind === "market" || (o.limitPrice ?? 0) > 0);
    if (!priceable) return { ok: false, reason: checked.ok ? "Ungültiger Auftrag." : checked.reason };
    const cost = previewCost(o.side, o.qty, ref, o.kind, o.limitPrice, sim.fees);
    return checked.ok ? { ok: true, cost } : { ok: true, cost, problem: checked.reason };
  }

  addDepot(id: number, name?: string): { ok: true; depot: Depot } | { ok: false; reason: string } {
    const sim = this.sim(id);
    if (sim.endedAt !== null) return { ok: false, reason: "Die Simulation ist beendet." };
    const count = this.store.listDepots(id).length;
    if (count >= MAX_DEPOTS) return { ok: false, reason: `Mehr als ${MAX_DEPOTS} Depots gibt es nicht.` };
    return { ok: true, depot: this.store.createDepot(id, name ?? `Depot ${count + 1}`) };
  }

  removeDepot(id: number, depotId: number): { ok: true } | { ok: false; reason: string } {
    const depots = this.store.listDepots(id);
    if (!depots.some((d) => d.id === depotId)) return { ok: false, reason: "Unbekanntes Depot." };
    if (depots.length === 1) return { ok: false, reason: "Das letzte Depot lässt sich nicht löschen." };
    this.store.deleteDepot(depotId);
    return { ok: true };
  }

  /**
   * Builds a depot from shares in percent. A dry run only plans. Otherwise one market order per
   * title with at least one piece goes through `placeOrder`, so it behaves like an order by hand
   * (an order waits while the market is shut).
   */
  allocate(
    id: number,
    depotId: number,
    weights: { symbol: string; percent: number }[],
    dryRun: boolean,
  ): { ok: true; lines: AllocationLine[] } | { ok: false; reason: string } {
    const sim = this.sim(id);
    if (!this.store.listDepots(id).some((d) => d.id === depotId)) return { ok: false, reason: "Unbekanntes Depot." };
    if (!dryRun && sim.endedAt !== null) return { ok: false, reason: "Die Simulation ist beendet." };

    const merged = new Map<string, number>();
    for (const w of weights) merged.set(w.symbol, (merged.get(w.symbol) ?? 0) + w.percent);
    let lines: AllocationLine[];
    try {
      lines = planAllocation(
        this.store.loadDepot(depotId).cash,
        [...merged].map(([symbol, percent]) => {
          const inst = this.registry.get(symbol);
          return { symbol, percent, ref: inst && this.refAt(inst, sim.simulationTime) };
        }),
        sim.fees,
      );
    } catch (err) {
      if (err instanceof RangeError) return { ok: false, reason: err.message };
      throw err;
    }
    for (const line of lines) if (!this.registry.get(line.symbol)) line.skipped = "Unbekanntes Wertpapier";
    if (!dryRun) {
      for (const line of lines) {
        if (line.qty === 0) continue;
        const placed = this.placeOrder(id, depotId, { symbol: line.symbol, side: "buy", kind: "market", qty: line.qty });
        if (!placed.ok) Object.assign(line, { qty: 0, total: 0, skipped: placed.reason });
      }
    }
    return { ok: true, lines };
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

    const prices: Snapshot["prices"] = {};
    for (const inst of this.instruments) {
      const bar = this.archive.lastCompleteBar(inst.symbol, s);
      if (bar) prices[inst.symbol] = { price: bar.c, barT: bar.t };
    }
    const refs = this.refsAt(s);
    const depots = this.store.listDepots(id).map((depot): DepotSnapshot => {
      const state = this.store.loadDepot(depot.id);
      return {
        id: depot.id,
        name: depot.name,
        cash: state.cash,
        value: depotValue(state, refs),
        positions: [...state.positions].map(([symbol, pos]) => ({
          symbol, qty: pos.qty, cost: pos.cost, value: positionValue(pos, refs.get(symbol)),
        })),
        orders: state.orders,
      };
    });

    const limitL = liveLimit(this.now(), this.delayS);
    const lag = limitL - s;
    // "Catching up" means there is something ahead to catch up on: a known bar after the clock.
    // A live simulation at the end of the data (the market is shut) has nothing to catch up on.
    const horizon = this.horizon();
    const barsAhead = horizon !== undefined && s < horizon;
    const phase: Snapshot["phase"] =
      lag <= CATCH_UP_LAG_S ? "live" : simulation.live ? (barsAhead ? "catchup" : "live") : "replay";

    return {
      simulation,
      running: this.isRunning(id),
      depots,
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

  /** The reference price of every instrument that has one at `s`. */
  private refsAt(s: number): Map<string, Ref> {
    const refs = new Map<string, Ref>();
    for (const inst of this.instruments) {
      const ref = this.refAt(inst, s);
      if (ref) refs.set(inst.symbol, ref);
    }
    return refs;
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
    const inst = this.registry.get(symbol)!;
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
