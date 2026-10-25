import { type Instrument, MAX_DEPOTS, VENUES, type Venue } from "./config.js";
import type { InstrumentRegistry } from "./instruments.js";
import type { Archive } from "./data/archive.js";
import { type Bar, MarketDataError } from "./data/marketdata.js";
import { type DepotState, type NewOrder, depotValue, fillOrder, positionValue, triggersLimit, validateOrder } from "./domain/broker.js";
import {
  CATCH_UP_LAG_S, LIVE_EDGE_S, LIVE_MARGIN_S, OPEN_WINDOW_S, type Tempo, advanceCarry, effectiveTempo, liveLimit, skipClosed,
} from "./domain/clock.js";
import { type AllocationLine, planAllocation } from "./domain/allocation.js";
import { type Breakdown, type FeeLedger, breakdown, feeLedger } from "./domain/breakdown.js";
import { type Correlation, type Metrics, type Point, type Relative, computeMetrics, correlationMatrix, relativeTo, thin } from "./domain/metrics.js";
import { BLOCKING_KINDS } from "./domain/quality.js";
import { closedDayReason } from "./domain/venues.js";
import { type Orderbook, buildOrderbook } from "./domain/orderbook.js";
import { type Journal, type JournalOrder, buildJournal } from "./domain/journal.js";
import { type CostPreview, type Ref, previewCost } from "./domain/fees.js";
import type { Cent } from "./domain/money.js";
import { applySplit, dividendCredit, showsSplit, splitOrder } from "./domain/events.js";
import type { Events } from "./events.js";
import type { Booking, Depot, DepotKind, OrderRecord, Simulation, Store } from "./store.js";

const DAY = 86400;
/** Prices for the simulation skip bars marked as outliers (#50). */
const SOUND = { skipFlagged: true } as const;
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
  /** Dividends and splits. Without it nothing is booked. */
  events?: Events;
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
  kind: DepotKind;
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
  /** Per market: "Feiertag: Karfreitag" when the calendar shuts the whole simulated day. Absent otherwise. */
  venueClosed: Partial<Record<Venue, string>>;
  /** The latest simulation time that may be shown: now minus the delay. */
  liveLimit: number;
  delayS: number;
  /** Replay, catching up to the present, or at the present. */
  phase: "replay" | "catchup" | "live";
}

export interface BenchmarkCurve {
  symbol: string;
  name: string;
  currency: Instrument["currency"];
  /** The instrument's price in its own currency at the times of the first depot's curve. */
  points: Point[];
}

export interface Curves {
  depots: { id: number; name: string; kind: DepotKind; points: Point[] }[];
  benchmark: BenchmarkCurve | null;
}

export interface Evaluation {
  depots: { id: number; name: string; kind: DepotKind; startedAt: number; metrics: Metrics; vsBenchmark: Relative | null; fees: FeeLedger; breakdown: Breakdown }[];
  correlation: Correlation;
  benchmark: { symbol: string; name: string; metrics: Metrics } | null;
  note: string;
}

const EVALUATION_POINTS = 5000;
const EVALUATION_NOTE =
  "Volatilität, Sharpe-Ratio und Korrelation sind aus der Kurve geschätzt, ohne risikofreien Zins. " +
  "Spread und Devisenaufschlag stecken im Ausführungspreis und fehlen in der Gebührenbilanz. " +
  "Der Maßstab ist der Kurs in seiner eigenen Währung, ohne Wechselkurs.";

const GHOST_NO_TRADE = "Ein Geisterdepot handelt nicht.";

/** One simulation in a comparison: curves in percent from their own start, on their own time axis. */
export interface Comparison {
  id: number;
  name: string;
  startAt: number;
  simulationTime: number;
  depots: {
    id: number;
    name: string;
    kind: DepotKind;
    startedAt: number;
    /** Percent change from the first point of the depot's curve. */
    points: { t: number; pct: number }[];
    figures: {
      /** Percent; null with fewer than two points. */
      returnPct: number | null;
      /** The deepest fall from a peak in percent (0 or negative); null with fewer than two points. */
      maxDrawdownPct: number | null;
      /** Commission and foreign fee booked, in cents. */
      fees: Cent;
      /** Filled orders. */
      trades: number;
    };
  }[];
}

export const COMPARE_POINTS = 400;

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
  private readonly events?: Events;
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
    this.events = deps.events;
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

  /** Stops every clock and forgets what a short tick left over: after a restore the ids mean other simulations. */
  reset(): void {
    this.running.clear();
    this.carry.clear();
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
      // A bar marked as an outlier (#50) triggers nothing and is not shown as new; the price stays at the last sound bar.
      const blocked = new Set(this.archive.flagsBetween(symbol, sOld - 59, target - 59, BLOCKING_KINDS).map((f) => f.t));
      const bars = this.archive.barsBetween(symbol, sOld - 59, target - 59).filter((b) => !blocked.has(b.t));
      if (bars.length > 0) newBars[symbol] = bars;
      for (const bar of bars) flat.push({ symbol, bar });
    }
    flat.sort((a, b) => a.bar.t - b.bar.t || a.symbol.localeCompare(b.symbol));

    const eventsOf = this.eventsFor(flat);
    this.store.transaction(() => {
      for (const depot of this.store.listDepots(id)) {
        const state = this.store.loadDepot(depot.id);
        let changed = false;
        for (const { symbol, bar } of flat) {
          // An ex-day is booked before the first bar of that day fills anything: whoever held the shares before it gets the credit.
          changed = this.bookEvents(depot, state, symbol, bar, eventsOf) || changed;
          changed = this.evaluate(state, sim, symbol, bar) || changed;
        }
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
    const target = this.store.listDepots(id).find((d) => d.id === depotId);
    if (!target) return { ok: false, reason: "Unbekanntes Depot." };
    if (target.kind === "ghost") return { ok: false, reason: GHOST_NO_TRADE };
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

    const depot = this.store.listDepots(id).find((d) => d.id === depotId) ?? this.firstNormal(id);
    if (depot.kind === "ghost") return { ok: false, reason: GHOST_NO_TRADE };
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
    const existing = this.store.listDepots(id);
    const count = existing.length;
    if (count >= MAX_DEPOTS) return { ok: false, reason: `Mehr als ${MAX_DEPOTS} Depots gibt es nicht.` };
    return { ok: true, depot: this.store.createDepot(id, name ?? this.nextDepotName(existing)) };
  }

  /** The depot an order goes to when none is named: the first normal one (a ghost can come first once its source is gone). */
  defaultDepotId(id: number): number {
    return this.firstNormal(id).id;
  }

  private firstNormal(id: number): Depot {
    const depots = this.store.listDepots(id);
    return depots.find((d) => d.kind === "normal") ?? depots[0];
  }

  /**
   * Freezes cash and positions of a depot at the current simulation time into a new ghost depot.
   * The ghost is valued at market like any depot, but never trades.
   */
  ghostDepot(id: number, depotId: number): { ok: true; depot: Depot } | { ok: false; reason: string } {
    const sim = this.sim(id);
    if (sim.endedAt !== null) return { ok: false, reason: "Die Simulation ist beendet." };
    const existing = this.store.listDepots(id);
    const source = existing.find((d) => d.id === depotId);
    if (!source) return { ok: false, reason: "Unbekanntes Depot." };
    if (source.kind === "ghost") return { ok: false, reason: "Von einem Geisterdepot gibt es keinen Geist." };
    const state = this.store.loadDepot(source.id);
    if (![...state.positions.values()].some((p) => p.qty > 0)) {
      return { ok: false, reason: "Ein Geisterdepot braucht mindestens eine Position." };
    }
    if (existing.length >= MAX_DEPOTS) return { ok: false, reason: `Mehr als ${MAX_DEPOTS} Depots gibt es nicht.` };
    const value = depotValue(state, this.refsAt(sim.simulationTime));
    return {
      ok: true,
      depot: this.store.createGhostDepot(id, `Geist von ${source.name}`, state.cash, state.positions, sim.simulationTime, value),
    };
  }

  /** A drawn book for display; reads one bar and writes nothing. Undefined for an unknown symbol. */
  orderbook(id: number, symbol: string): Orderbook | undefined {
    const inst = this.registry.get(symbol);
    if (!inst) return undefined;
    const s = this.sim(id).simulationTime;
    return buildOrderbook({
      symbol: inst.symbol, currency: inst.currency, bar: this.archive.lastCompleteBar(inst.symbol, s, SOUND), venueOpen: this.venueOpen(inst.venue, s),
    });
  }

  /** Normalised curves and key figures of one simulation, computed now. */
  compare(id: number): Comparison {
    const sim = this.sim(id);
    const depots = this.store.listDepots(id).map((d) => {
      const full = this.store.valueCurve(d.id, EVALUATION_POINTS);
      const metrics = computeMetrics(full);
      const first = full[0]?.value ?? 0;
      const points = thin(full, COMPARE_POINTS).map((p) => ({ t: p.t, pct: first === 0 ? 0 : (p.value / first - 1) * 100 }));
      const ledger = feeLedger(this.store.loadDepot(d.id).orders, sim.startCash);
      return {
        id: d.id, name: d.name, kind: d.kind, startedAt: full[0]?.t ?? sim.startAt, points,
        figures: {
          returnPct: metrics.totalReturn === null ? null : metrics.totalReturn * 100,
          maxDrawdownPct: metrics.maxDrawdown === null ? null : metrics.maxDrawdown * 100,
          fees: ledger.total,
          trades: ledger.orders,
        },
      };
    });
    return { id, name: sim.name, startAt: sim.startAt, simulationTime: sim.simulationTime, depots };
  }

  /** Trades, hit rate, holding time and "too early" of one depot, computed now from its filled orders. */
  journal(id: number, depotId: number): Journal & { bookings: Booking[]; depotId: number; simulationTime: number } {
    const sim = this.sim(id);
    const filled: JournalOrder[] = [];
    for (const o of this.store.loadDepot(depotId).orders) {
      if (o.status !== "filled" || o.filledSim === undefined || o.fillPrice === undefined) continue;
      filled.push({
        id: o.id, symbol: o.symbol, side: o.side, qty: o.qty, fillPrice: o.fillPrice, filledSim: o.filledSim,
        gross: o.gross ?? 0, commission: o.commission ?? 0, foreignFee: o.foreignFee ?? 0,
      });
    }
    const journal = buildJournal({ orders: filled, s: sim.simulationTime, bars: this.archive, notes: this.store.notes(id) });
    return { ...journal, bookings: this.store.bookings(depotId), depotId, simulationTime: sim.simulationTime };
  }

  /** True if the key names a trade of any normal depot of the simulation. */
  hasTrade(id: number, tradeKey: string): boolean {
    return this.store
      .listDepots(id)
      .filter((d) => d.kind === "normal")
      .some((d) => this.journal(id, d.id).trades.some((t) => t.key === tradeKey));
  }

  /** "Depot N" with N one above the highest number in use, so a deleted depot's name is not given out again. */
  private nextDepotName(existing: Depot[]): string {
    const used = existing.map((d) => Number(/^Depot (\d+)$/.exec(d.name)?.[1] ?? 0));
    return `Depot ${Math.max(existing.length, ...used) + 1}`;
  }

  removeDepot(id: number, depotId: number): { ok: true } | { ok: false; reason: string } {
    const depots = this.store.listDepots(id);
    if (!depots.some((d) => d.id === depotId)) return { ok: false, reason: "Unbekanntes Depot." };
    const target = depots.find((d) => d.id === depotId)!;
    // At least one normal depot stays; a ghost may always go.
    if (target.kind === "normal" && !depots.some((d) => d.kind === "normal" && d.id !== depotId)) {
      return { ok: false, reason: "Das letzte Depot lässt sich nicht löschen." };
    }
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
    const target = this.store.listDepots(id).find((d) => d.id === depotId);
    if (!target) return { ok: false, reason: "Unbekanntes Depot." };
    if (target.kind === "ghost") return { ok: false, reason: GHOST_NO_TRADE };
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

  /** The value curve of every depot, thinned for a chart, and the benchmark at the same times. */
  curves(id: number): Curves {
    const sim = this.sim(id);
    const depots = this.store.listDepots(id).map((d) => ({ id: d.id, name: d.name, kind: d.kind, points: this.store.valueCurve(d.id) }));
    const inst = sim.benchmark ? this.registry.get(sim.benchmark) : undefined;
    if (!inst) return { depots, benchmark: null };
    const points: Point[] = [];
    for (const p of (depots.find((d) => d.kind === "normal") ?? depots[0])?.points ?? []) {
      const bar = this.archive.lastCompleteBar(inst.symbol, p.t, SOUND);
      if (bar) points.push({ t: p.t, value: bar.c });
    }
    return { depots, benchmark: { symbol: inst.symbol, name: inst.name, currency: inst.currency, points } };
  }

  /** Figures per depot, how the depots move together, and the benchmark measured the same way. */
  evaluation(id: number): Evaluation {
    const sim = this.sim(id);
    const refs = this.refsAt(sim.simulationTime);
    const curves = this.store.listDepots(id).map((d) => ({ depot: d, points: this.store.valueCurve(d.id, EVALUATION_POINTS) }));
    const inst = sim.benchmark ? this.registry.get(sim.benchmark) : undefined;
    const benchSeries: Point[] | null = inst
      ? thin(
        this.archive
          .barsBetween(inst.symbol, sim.startAt - 59, sim.simulationTime - 59)
          .map((b) => ({ t: b.t + 60, value: b.c })),
        EVALUATION_POINTS,
      )
      : null;
    const depots = curves.map(({ depot, points }) => {
      const state = this.store.loadDepot(depot.id);
      const held = [...state.positions].map(([symbol, pos]) => ({ symbol, value: positionValue(pos, refs.get(symbol)) }));
      return {
        id: depot.id,
        name: depot.name,
        kind: depot.kind,
        startedAt: points[0]?.t ?? sim.startAt,
        metrics: computeMetrics(points),
        vsBenchmark: benchSeries ? relativeTo(points, benchSeries) : null,
        fees: feeLedger(state.orders, sim.startCash),
        breakdown: breakdown(held, state.cash, this.instruments),
      };
    });
    const benchmark: Evaluation["benchmark"] = inst && benchSeries
      ? { symbol: inst.symbol, name: inst.name, metrics: computeMetrics(benchSeries) }
      : null;
    return {
      depots,
      correlation: correlationMatrix(curves.map(({ depot, points }) => ({ id: depot.id, points }))),
      benchmark,
      note: EVALUATION_NOTE,
    };
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

  /** The markets that are shut for a holiday on the day of UTC second `t`, with the German reason. */
  private holidays(t: number): Partial<Record<Venue, string>> {
    const out: Partial<Record<Venue, string>> = {};
    for (const v of VENUES) {
      const reason = v.hasSource ? closedDayReason(v, t) : undefined;
      if (reason?.startsWith("Feiertag")) out[v.id as Venue] = reason;
    }
    return out;
  }

  /**
   * For a live simulation: "Markt geschlossen (Feiertag: Karfreitag)" when, right now, the calendar
   * shuts the whole day on every market that has an instrument on the list (a weekend counts).
   * Undefined for a replay, for an open day, or when only some of the markets are shut.
   */
  closedNotice(id: number): string | undefined {
    if (!this.sim(id).live) return undefined;
    const used = new Set<string>(this.instruments.map((i) => i.venue));
    const reasons = new Set<string>();
    for (const v of VENUES) {
      if (!used.has(v.id)) continue;
      const reason = closedDayReason(v, this.now());
      if (!reason) return undefined;
      reasons.add(reason);
    }
    return reasons.size === 0 ? undefined : `Markt geschlossen (${[...reasons].join("; ")})`;
  }

  snapshot(id: number): Snapshot {
    const simulation = this.sim(id);
    const s = simulation.simulationTime;

    const prices: Snapshot["prices"] = {};
    for (const inst of this.instruments) {
      const bar = this.archive.lastCompleteBar(inst.symbol, s, SOUND);
      if (bar) prices[inst.symbol] = { price: bar.c, barT: bar.t };
    }
    const refs = this.refsAt(s);
    const depots = this.store.listDepots(id).map((depot): DepotSnapshot => {
      const state = this.store.loadDepot(depot.id);
      return {
        id: depot.id,
        name: depot.name,
        kind: depot.kind,
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
      fx: this.archive.lastCompleteBar(this.fx, s, SOUND)?.c ?? null,
      venues: { XETRA: this.venueOpen("XETRA", s), US: this.venueOpen("US", s) },
      venueClosed: this.holidays(s),
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
    // Events are needed before the clock passes an ex-day; a failure there never stops the simulation.
    if (this.events) for (const inst of this.instruments) await this.events.ensure(inst.symbol);
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
    const bar = this.archive.lastCompleteBar(inst.symbol, s, SOUND);
    if (!bar) return undefined;
    if (inst.currency === "EUR") return { price: bar.c, currency: "EUR" };
    const eurUsd = this.archive.lastCompleteBar(this.fx, s, SOUND)?.c;
    return eurUsd === undefined ? undefined : { price: bar.c, currency: "USD", eurUsd };
  }

  /** The dividends and splits of the symbols and days that the bars of a tick touch. */
  private eventsFor(flat: { symbol: string; bar: Bar }[]): Map<string, { dividends: { exDay: string; amount: number }[]; splits: { day: string; numerator: number; denominator: number }[] }> {
    const out = new Map<string, { dividends: { exDay: string; amount: number }[]; splits: { day: string; numerator: number; denominator: number }[] }>();
    if (!this.events || flat.length === 0) return out;
    const range = new Map<string, { from: number; to: number }>();
    for (const { symbol, bar } of flat) {
      const r = range.get(symbol);
      range.set(symbol, { from: Math.min(r?.from ?? bar.t, bar.t), to: Math.max(r?.to ?? bar.t, bar.t) });
    }
    const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
    for (const [symbol, r] of range) {
      const dividends = this.events.dividends(symbol, iso(r.from), iso(r.to));
      const splits = this.events.splits(symbol, iso(r.from), iso(r.to));
      if (dividends.length > 0 || splits.length > 0) out.set(symbol, { dividends, splits });
    }
    return out;
  }

  /**
   * Books the distribution and the split of a symbol on the first sound bar of its ex-day. Once per
   * depot: the booking table refuses a second write for the same ex-day, so a restart or a repeated
   * tick changes nothing. A ghost depot gets them like any depot that holds the shares.
   */
  private bookEvents(
    depot: Depot, state: DepotState & { orders: OrderRecord[] }, symbol: string, bar: Bar,
    eventsOf: ReturnType<SessionService["eventsFor"]>,
  ): boolean {
    const ev = eventsOf.get(symbol);
    const pos = state.positions.get(symbol);
    if (!ev || !pos) return false;
    const day = new Date(bar.t * 1000).toISOString().slice(0, 10);
    const dividends = ev.dividends.filter((d) => d.exDay === day);
    const splits = ev.splits.filter((s) => s.day === day);
    if (dividends.length === 0 && splits.length === 0) return false;
    const dayStart = dayOf(bar.t);
    const blocked = new Set(this.archive.flagsBetween(symbol, dayStart, bar.t + 1, BLOCKING_KINDS).map((f) => f.t));
    const first = this.archive.barsBetween(symbol, dayStart, bar.t + 1).find((b) => !blocked.has(b.t));
    if (!first || first.t !== bar.t) return false;

    const inst = this.registry.get(symbol)!;
    let rate = 1;
    if (inst.currency === "USD") {
      const eurUsd = this.archive.lastCompleteBar(this.fx, bar.t + 60, SOUND)?.c;
      if (eurUsd === undefined) return false;
      rate = eurUsd;
    }
    const eur = (c: Cent) => `${(c / 100).toFixed(2).replace(".", ",")} €`;
    let changed = false;
    for (const d of dividends) {
      const qty = state.positions.get(symbol)?.qty ?? 0;
      const amount = dividendCredit(qty, d.amount, rate);
      if (amount <= 0) continue;
      const booking: Booking = { t: bar.t, kind: "dividend", symbol, ref: d.exDay, amount, text: `Ausschüttung ${symbol} ${eur(amount)}` };
      if (this.store.addBooking(depot.id, booking)) {
        state.cash += amount;
        changed = true;
      }
    }
    for (const sp of splits) {
      const before = this.archive.lastCompleteBar(symbol, bar.t, SOUND);
      if (!before || !showsSplit(before.c, bar.o, sp.numerator, sp.denominator)) continue;
      const held = state.positions.get(symbol);
      if (!held) continue;
      const probe = { ...state, positions: new Map(state.positions) };
      const priceEur = inst.currency === "USD" ? bar.o / rate : bar.o;
      const res = applySplit(probe, symbol, sp.numerator, sp.denominator, priceEur);
      if (!res) continue;
      const booking: Booking = {
        t: bar.t, kind: "split", symbol, ref: sp.day, amount: res.cashOut,
        text: `Aktiensplit ${symbol} ${sp.numerator}:${sp.denominator}, ${held.qty} → ${res.qty} Stück` + (res.cashOut > 0 ? `, Bruchteil ${eur(res.cashOut)}` : ""),
      };
      if (!this.store.addBooking(depot.id, booking)) continue;
      applySplit(state, symbol, sp.numerator, sp.denominator, priceEur);
      this.store.splitOpenOrders(depot.id, symbol, sp.numerator, sp.denominator);
      for (const o of state.orders) {
        if (o.status === "open" && o.symbol === symbol) {
          const s = splitOrder(o.qty, o.limitPrice, sp.numerator, sp.denominator);
          o.qty = s.qty;
          o.limitPrice = s.limitPrice;
        }
      }
      changed = true;
    }
    return changed;
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
        const eurUsd = this.archive.lastCompleteBar(this.fx, bar.t + 60, SOUND)?.c;
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
