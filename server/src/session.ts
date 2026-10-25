import { type Instrument, MAX_DEPOTS, VENUES, type Venue } from "./config.js";
import type { InstrumentRegistry } from "./instruments.js";
import type { Archive } from "./data/archive.js";
import { type Bar, MarketDataError } from "./data/marketdata.js";
import { type DepotState, type NewOrder, depotValue, fillOrder, positionValue, triggersLimit, validateOrder } from "./domain/broker.js";
import {
  CATCH_UP_LAG_S, type JumpKind, LIVE_EDGE_S, LIVE_MARGIN_S, OPEN_WINDOW_S, TIME_LAPSE, type Tempo, advanceCarry, effectiveTempo, liveLimit, nextStop, skipClosed,
} from "./domain/clock.js";
import { type AllocationLine, planAllocation } from "./domain/allocation.js";
import { type Breakdown, type FeeLedger, breakdown, feeLedger } from "./domain/breakdown.js";
import { type Correlation, type Metrics, type Point, type Relative, computeMetrics, correlationMatrix, relativeTo, thin } from "./domain/metrics.js";
import { BLOCKING_KINDS } from "./domain/quality.js";
import { CLOCK_STOPPED_REFUSED, JUMP_REFUSED } from "./domain/rules.js";
import { closedDayReason } from "./domain/venues.js";
import { type Diversification, type HeldSeries, diversify } from "./domain/diversification.js";
import { HINT_ORDER, HINT_RULES, type Hint, type HintRule, type RuleConfig, defaultConfig, evaluateHints, orderNotes } from "./domain/hints.js";
import { type GoalOutcome, evaluateGoals, scenarioById } from "./domain/scenario.js";
import { GRADE_FORMULA, type Grade, gradeRun } from "./domain/grade.js";
import { type Calendar, buildCalendar } from "./domain/dividendCalendar.js";
import { type AutoPauseRule, type Signals, distanceToLimit, jumpOf, noSignals, pauseReason } from "./domain/autopause.js";
import { type MarketEvent, marketEvents } from "./domain/marketEvents.js";
import { type Analysis, type BetaPoint, BETA_WINDOW, analyze, rollingBeta } from "./domain/rolling.js";
import { type Orderbook, buildOrderbook } from "./domain/orderbook.js";
import { type Behavior, analyzeBehavior } from "./domain/behavior.js";
import { type Excursion, type ExcursionBars, type ExcursionSummary, openExcursion, summarize, tradeExcursion } from "./domain/excursions.js";
import { type Journal, type JournalOrder, type JournalTrade, type OpenLot, buildJournalCore } from "./domain/journal.js";
import { type CostPreview, type Ref, previewCost } from "./domain/fees.js";
import type { Cent } from "./domain/money.js";
import { applySplit, dividendCredit, showsSplit, splitOrder } from "./domain/events.js";
import type { Events } from "./events.js";
import type { DailyArchive } from "./data/dailyarchive.js";
import type { Booking, Depot, DepotKind, OrderRecord, Simulation, Store } from "./store.js";

const DAY = 86400;
/** Prices for the simulation skip bars marked as outliers (#50). */
const SOUND = { skipFlagged: true } as const;
const LOOKAHEAD_DAYS = 7;
const DEFAULT_DELAY_S = 900;
const DEFAULT_CATCH_UP_TEMPO = 300;
const dayOf = (t: number) => Math.floor(t / DAY) * DAY;
const isoDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
/** Daily bars stepped through at once by one tick; more than this in a tick is held back so a pause answers quickly. */
const MAX_DAY_STEPS = 40;

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
  /** Daily prices, for simulations that play one day per step. Without it a daily simulation cannot start. */
  daily?: DailyArchive;
  /** Units of a currency per EUR on a UTC day ("USD"), for daily simulations. */
  fxRate?: (ccy: string, day: string) => number | undefined;
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
  /** What the tick did that an auto-pause rule may care about; absent for a tick that was not asked for them. */
  signals?: Signals;
}

export interface RollingResult {
  simulationTime: number;
  depot: Analysis;
  /** Absent without a benchmark: then only the depot is shown. */
  benchmark: (Analysis & { symbol: string; name: string }) | null;
  beta: { window: number; points: BetaPoint[] };
}

export interface JumpResult {
  ok: true;
  simulationTime: number;
  /** All bars that finished during the jump, per instrument. */
  newBars: Record<string, Bar[]>;
  /** Why the jump ended before its target, or null when it arrived. */
  stopped: { rule: AutoPauseRule | "fill" | "data" | "end"; reason: string } | null;
  target: number;
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

export type OpenExcursion = Excursion & { symbol: string; qty: number; openedSim: number };

/** The after-the-fact figures of the journal: per closed trade by key, per open lot, and over all. */
export interface Excursions {
  benchmark: string | null;
  trades: Record<string, Excursion>;
  open: OpenExcursion[];
  summary: ExcursionSummary;
}

export interface Curves {
  depots: { id: number; name: string; kind: DepotKind; points: Point[] }[];
  benchmark: BenchmarkCurve | null;
}

export interface Evaluation {
  depots: { id: number; name: string; kind: DepotKind; startedAt: number; metrics: Metrics; vsBenchmark: Relative | null; fees: FeeLedger; breakdown: Breakdown; diversification: Diversification | null }[];
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

export interface ScenarioResult extends GoalOutcome {
  scenarioId: string;
  title: string;
  finished: boolean;
  simulationTime: number;
  endAt: number | null;
  depotId: number;
}

/** A round in the round book: the figures of the first normal depot, with the grade and a thinned curve for the card. */
export interface RunSummary {
  id: number;
  name: string;
  startAt: number;
  simulationTime: number;
  endedAt: number | null;
  /** The round is over; before that these are figures of the moment and are worked out afresh each time. */
  finished: boolean;
  preset: Simulation["rules"]["preset"];
  resolution: Simulation["resolution"];
  scenarioId: string | null;
  scenarioTitle: string | null;
  startCash: Cent;
  finalValue: Cent;
  totalReturn: number | null;
  benchmarkSymbol: string | null;
  benchmarkReturn: number | null;
  maxDrawdown: number | null;
  fees: Cent;
  feeShare: number;
  trades: number;
  hitRate: number | null;
  closedTrades: number;
  grade: Grade;
  /** How the grade comes about, in words; the one source of the text the card shows. */
  gradeFormula: string;
  /** Stars and goals of a scenario round. */
  scenario: ScenarioResult | null;
  curve: { depot: Point[]; benchmark: Point[] | null };
}

const RUN_CURVE_POINTS = 120;

export interface HintsResult {
  depotId: number;
  simulationTime: number;
  hints: Hint[];
  /** Hints that apply but were hidden by the person. */
  hiddenCount: number;
  rules: { rule: HintRule; label: string; unit: string; defaults: number[]; enabled: boolean; levels: number[]; hidden: boolean }[];
}

export type PlaceResult = { ok: true; orderId: number } | { ok: false; reason: string };

/** `problem` is why the order would be rejected; the cost is shown anyway. */
export type PreviewResult = { ok: true; cost: CostPreview; problem?: string; notes?: string[] } | { ok: false; reason: string };

export class SessionService {
  private readonly store: Store;
  private readonly archive: Archive;
  private readonly registry: InstrumentRegistry;
  private readonly fx: string;
  private readonly now: () => number;
  private readonly delayS: number;
  private readonly catchUpTempo: number;
  private readonly events?: Events;
  private readonly daily?: DailyArchive;
  private readonly fxRate?: (ccy: string, day: string) => number | undefined;
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
    this.daily = deps.daily;
    this.fxRate = deps.fxRate;
  }

  /** The tradable instruments right now. The list can grow while the service runs, so it is read on every use. */
  private get instruments(): Instrument[] {
    return this.registry.list();
  }

  /** Loads the start day of every instrument. Throws, and starts nothing, if there are no prices. */
  async start(id: number): Promise<void> {
    if (this.sim(id).resolution === "day") return this.startDay(id);
    const day = dayOf(this.sim(id).simulationTime);
    await this.loadDay(day);
    const traded = this.instruments.some((i) => this.archive.barsBetween(i.symbol, day, day + DAY).length > 0);
    if (!traded) throw new MarketDataError("no_data", "Für diesen Tag liegen keine Kurse vor.");
  }

  /** Loads the daily prices (and events) of every instrument. A rate limit or a network failure is thrown; nothing to trade is no_data. */
  private async startDay(id: number): Promise<void> {
    if (!this.events || !this.daily) throw new MarketDataError("no_data", "Tageskurse sind nicht eingerichtet.");
    const from = this.sim(id).simulationTime;
    for (const inst of this.instruments) await this.events.ensureStrict(inst.symbol);
    if (!this.instruments.some((i) => this.daily!.nextAfter(i.symbol, from - 1))) {
      throw new MarketDataError("no_data", "Für diesen Zeitraum liegen keine Tageskurse vor.");
    }
  }

  /**
   * Fetches what a new instrument needs to show up: for every simulation that has not ended, the day
   * of its clock and the three days before it (three calendar days reach back over a weekend). A day
   * without trading is not an error. A rate limit or a network failure is passed on.
   */
  async prepareInstrument(inst: Instrument): Promise<void> {
    const days = new Set<number>();
    if (this.events && this.store.listSimulations().some((s) => s.endedAt === null && s.resolution === "day")) await this.events.ensure(inst.symbol);
    for (const sim of this.store.listSimulations()) {
      if (sim.endedAt !== null || sim.resolution === "day") continue;
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
    if (this.sim(id).resolution === "day") return false; // the daily prices were loaded at the start
    const s = this.sim(id).simulationTime;
    for (let d = 0; d <= LOOKAHEAD_DAYS; d++) {
      const day = dayOf(s) + d * DAY;
      if (day > this.now()) break;
      await this.loadDay(day);
      if (this.instruments.some((i) => this.archive.nextBarAfter(i.symbol, s - 60))) return true;
    }
    return false;
  }

  /**
   * The two fastest tempi (time lapse) need minute prices, a replay and no open order: at 300 times an order would be passed
   * over unseen. Any other tempo is always allowed.
   */
  setTempo(id: number, tempo: Tempo): { ok: true } | { ok: false; reason: string } {
    if (TIME_LAPSE.includes(tempo)) {
      const sim = this.sim(id);
      if (sim.resolution === "day") return { ok: false, reason: "Zeitraffer gibt es nur mit Minutenkursen." };
      if (sim.live) return { ok: false, reason: "Im Livebetrieb bestimmt die Uhr das Tempo." };
      if (this.store.listDepots(id).some((d) => this.store.loadDepot(d.id).orders.some((o) => o.status === "open"))) {
        return { ok: false, reason: "Zeitraffer geht nur ohne offene Orders. Lösche sie oder warte, bis sie ausgeführt sind." };
      }
    }
    this.store.setTempo(id, tempo);
    return { ok: true };
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
  /**
   * Moves the clock by `realMs` of real time, or, with `cap`, not past that simulation time (a jump goes to a target in
   * steps). The signals tell what the tick did: orders executed, dividends booked.
   */
  tick(id: number, realMs: number, cap?: number): TickResult {
    this.signals = noSignals();
    try {
      const r = this.tickCore(id, realMs, cap);
      r.signals = this.signals;
      return r;
    } finally {
      this.signals = null;
    }
  }

  private signals: Signals | null = null;

  private tickCore(id: number, realMs: number, cap = Infinity): TickResult {
    const sim = this.sim(id);
    if (sim.endedAt !== null) {
      return { simulationTime: sim.simulationTime, newBars: {}, endOfData: true, waitingForData: false, liveEdge: false };
    }

    if (sim.resolution === "day") return this.tickDay(id, realMs);

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
      // A jump names its target; otherwise the real time that passed decides how far the clock moves.
      const step = cap === Infinity ? advanceCarry(sOld, tempo, realMs, this.carry.get(id) ?? 0) : { s: cap, carry: 0 };
      raw = step.s;
      carryOut = step.carry;
      advanced = true;
    }
    const capped = Math.min(raw, limitL, sim.endAt ?? Infinity, cap);
    const skipped = skipClosed(capped, symbols, this.archive);
    const endOfData = skipped === undefined;
    const target0 = skipped === undefined ? capped : Math.min(skipped, limitL, sim.endAt ?? Infinity, cap);

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
      // A scenario ends where it says: the clock stops, nothing later is shown.
      if (sim.endAt !== null && target >= sim.endAt) this.store.endSimulation(id);
      // One curve point per depot whenever the clock passes a minute boundary.
      if (Math.floor(target / 60) > Math.floor(sOld / 60)) {
        for (const depot of this.store.listDepots(id)) {
          this.store.recordValue(depot.id, target, depotValue(this.store.loadDepot(depot.id), this.refsAt(target)));
        }
      }
    });

    return { simulationTime: target, newBars, endOfData: endOfData || (sim.endAt !== null && target >= sim.endAt), waitingForData, liveEdge };
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
    if (!sim.rules.pauseAllowed && !this.isRunning(id)) return { ok: false, reason: CLOCK_STOPPED_REFUSED };

    const s = sim.simulationTime;
    const ref = this.refAt(inst, s, sim.resolution === "day");
    // No price now and no bar to come in the archive (an instrument added later, or one the source
    // does not know): the order would wait for good, and an open order blocks removing the
    // instrument. An order before the first bar of the day is different: that bar is known.
    const day = sim.resolution === "day";
    if (!ref && !(day ? this.daily?.nextAfter(o.symbol, s - 1) : this.archive.nextBarAfter(o.symbol, s - 60))) {
      return { ok: false, reason: `Für ${o.symbol} gibt es noch keinen Kurs.` };
    }
    return this.store.transaction((): PlaceResult => {
      const state = this.store.loadDepot(depotId);
      const checked = validateOrder(state, o, ref, sim.fees);
      if (!checked.ok) return checked;
      const max = sim.rules.maxPositions;
      if (max !== null && o.side === "buy" && !state.positions.has(o.symbol) && state.positions.size >= max) {
        return { ok: false, reason: `In dieser Simulation sind höchstens ${max} verschiedene Positionen erlaubt.` };
      }

      const orderId = this.store.insertOrder(depotId, o, s);
      // A market order fills now if the market is open. Otherwise it waits for the first bar.
      if (!day && o.kind === "market" && ref && this.venueOpen(inst.venue, s)) {
        const order = { ...o, id: orderId, status: "open" as const };
        const exec = previewCost(o.side, o.qty, ref, "market", undefined, sim.fees);
        fillOrder(state, order, exec);
        this.store.saveBalance(depotId, state.cash, state.positions);
        this.store.markFilled(orderId, {
          filledSim: s, fillPrice: exec.execPrice, gross: exec.gross, commission: exec.commission, foreignFee: exec.foreign,
        });
      }
      // An order must not be passed over at time-lapse speed: the clock drops to the fastest tempo that watches it.
      if (TIME_LAPSE.includes(sim.tempo)) this.store.setTempo(id, 60);
      return { ok: true, orderId };
    });
  }

  /** What the order would cost at the current price, with the same numbers a fill would use. */
  previewOrder(id: number, o: NewOrder, depotId?: number): PreviewResult {
    const sim = this.sim(id);
    const inst = this.registry.get(o.symbol);
    if (!inst) return { ok: false, reason: `Unbekanntes Wertpapier ${o.symbol}.` };
    const ref = this.refAt(inst, sim.simulationTime, sim.resolution === "day");
    if (!ref) return { ok: false, reason: `Für ${o.symbol} gibt es noch keinen Kurs.` };

    const depot = this.store.listDepots(id).find((d) => d.id === depotId) ?? this.firstNormal(id);
    if (depot.kind === "ghost") return { ok: false, reason: GHOST_NO_TRADE };
    const state = this.store.loadDepot(depot.id);
    const checked = validateOrder(state, o, ref, sim.fees);
    const priceable = Number.isInteger(o.qty) && o.qty > 0 && (o.kind === "market" || (o.limitPrice ?? 0) > 0);
    if (!priceable) return { ok: false, reason: checked.ok ? "Ungültiger Auftrag." : checked.reason };
    const cost = previewCost(o.side, o.qty, ref, o.kind, o.limitPrice, sim.fees);
    const notes = this.orderRemarks(sim, state, o, ref, cost);
    const extra = notes.length > 0 ? { notes } : {};
    return checked.ok ? { ok: true, cost, ...extra } : { ok: true, cost, problem: checked.reason, ...extra };
  }

  /** What the order would do to the weight of its position, and a flat fee that is large next to it. */
  private orderRemarks(sim: Simulation, state: DepotState, o: NewOrder, ref: Ref, cost: CostPreview): string[] {
    const refs = this.refsAt(sim.simulationTime, sim.resolution === "day");
    const held = state.positions.get(o.symbol);
    const afterValue = (held ? positionValue(held, refs.get(o.symbol)) : 0) + (o.side === "buy" ? cost.gross : 0);
    return orderNotes({
      side: o.side, symbol: o.symbol, depotValue: depotValue(state, refs), afterValue, foreignFee: cost.foreign, orderTotal: cost.total,
    }, this.hintConfig(sim.id).config);
  }

  private hintConfig(id: number): { config: Record<HintRule, RuleConfig>; hidden: Set<string> } {
    const prefs = this.store.hintPrefs(id);
    const config = defaultConfig();
    const hidden = new Set<string>();
    for (const rule of HINT_ORDER) {
      const p = prefs[rule];
      if (!p) continue;
      config[rule] = { enabled: p.enabled, levels: p.levels && p.levels.length === HINT_RULES[rule].defaults.length ? p.levels : config[rule].levels };
      if (p.hidden) hidden.add(rule);
    }
    return { config, hidden };
  }

  /** The hints that apply to a depot at the simulation time, and the settings of every rule. */
  hints(id: number, depotId: number): HintsResult | undefined {
    const sim = this.sim(id);
    const depot = this.store.listDepots(id).find((d) => d.id === depotId);
    if (!depot) return undefined;
    const state = this.store.loadDepot(depotId);
    const refs = this.refsAt(sim.simulationTime, sim.resolution === "day");
    const known = new Map(this.instruments.map((i) => [i.symbol, i]));
    const curve = this.store.valueCurve(depotId, EVALUATION_POINTS);
    const { config, hidden } = this.hintConfig(id);
    const trades = depot.kind === "normal" ? this.journal(id, depotId).trades : [];
    const all = evaluateHints({
      depotValue: depotValue(state, refs),
      cash: state.cash,
      startCash: sim.startCash,
      positions: [...state.positions].map(([symbol, pos]) => {
        const i = known.get(symbol);
        return {
          symbol, value: positionValue(pos, refs.get(symbol)), currency: i?.currency ?? "EUR",
          sector: i ? (i.kind === "ETF" ? "ETF/Fonds" : i.sector ?? "Unbekannt") : "Unbekannt",
        };
      }),
      curve,
      now: sim.simulationTime,
      feeShareOfStart: feeLedger(state.orders, sim.startCash).shareOfStart,
      trades,
      metricsBasis: computeMetrics(curve).basis,
    }, config);
    return {
      depotId,
      simulationTime: sim.simulationTime,
      hints: all.filter((h) => !hidden.has(h.rule)),
      hiddenCount: all.filter((h) => hidden.has(h.rule)).length,
      rules: HINT_ORDER.map((rule) => ({
        rule, label: HINT_RULES[rule].label, unit: HINT_RULES[rule].unit, defaults: HINT_RULES[rule].defaults,
        enabled: config[rule].enabled, levels: config[rule].levels, hidden: hidden.has(rule),
      })),
    };
  }

  setHintPref(id: number, rule: string, patch: { enabled?: boolean; hidden?: boolean; levels?: number[] }): { ok: true } | { ok: false; reason: string } {
    if (!(rule in HINT_RULES)) return { ok: false, reason: "Unbekannte Regel." };
    const r = rule as HintRule;
    if (patch.levels !== undefined) {
      const want = HINT_RULES[r].defaults.length;
      if (patch.levels.length !== want || want === 0) return { ok: false, reason: "Diese Regel hat keine Schwelle zu ändern." };
      if (patch.levels.some((x) => !Number.isFinite(x) || x < 0) || patch.levels.some((x, i) => i > 0 && x < patch.levels![i - 1])) {
        return { ok: false, reason: "Die Schwellen müssen aufsteigend und nicht negativ sein." };
      }
    }
    this.store.setHintPref(id, rule, patch);
    return { ok: true };
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
    const value = depotValue(state, this.refsAt(sim.simulationTime, sim.resolution === "day"));
    return {
      ok: true,
      depot: this.store.createGhostDepot(id, `Geist von ${source.name}`, state.cash, state.positions, sim.simulationTime, value),
    };
  }

  /** A drawn book for display; reads one bar and writes nothing. Undefined for an unknown symbol. */
  orderbook(id: number, symbol: string): Orderbook | undefined {
    const inst = this.registry.get(symbol);
    if (!inst) return undefined;
    const sim = this.sim(id);
    const s = sim.simulationTime;
    if (sim.resolution === "day") return buildOrderbook({ symbol: inst.symbol, currency: inst.currency, bar: undefined, venueOpen: false });
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

  /** The goals of the scenario against the first normal depot: while it runs "on course", at the end the stars. */
  result(id: number): ScenarioResult | undefined {
    const sim = this.sim(id);
    const scenario = sim.scenarioId ? scenarioById(sim.scenarioId) : undefined;
    if (!scenario) return undefined;
    const ev = this.evaluation(id);
    const depot = this.firstNormal(id);
    const row = ev.depots.find((d) => d.id === depot.id) ?? ev.depots[0];
    const finalValue = depotValue(this.store.loadDepot(depot.id), this.refsAt(sim.simulationTime, sim.resolution === "day"));
    const outcome = evaluateGoals(scenario, {
      startCash: sim.startCash, finalValue, maxDrawdown: row.metrics.maxDrawdown, depotReturn: row.metrics.totalReturn,
      benchmarkReturn: ev.benchmark?.metrics.totalReturn ?? null, fees: row.fees.total,
    });
    return { scenarioId: scenario.id, title: scenario.title, finished: sim.endedAt !== null, simulationTime: sim.simulationTime, endAt: sim.endAt, depotId: depot.id, ...outcome };
  }

  /**
   * The distributions of the titles a depot holds or held, up to the last finished day: what the source knows, what the depot
   * was credited, yields, and the income by month and year. Nothing after the simulation time.
   */
  dividendCalendar(id: number, depotId: number): Calendar {
    const sim = this.sim(id);
    const day = sim.resolution === "day";
    const state = this.store.loadDepot(depotId);
    const refs = this.refsAt(sim.simulationTime, day);
    const bookings = this.store.bookings(depotId).filter((b) => b.kind === "dividend");
    const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
    const today = iso(sim.simulationTime - 1);
    const symbols = [...new Set([...state.positions.keys(), ...bookings.map((b) => b.symbol)])].sort();
    const eurUsd = [...refs.values()].find((r) => r.eurUsd !== undefined)?.eurUsd;
    const titles = symbols.flatMap((symbol) => {
      const inst = this.registry.get(symbol);
      if (!inst) return [];
      const pos = state.positions.get(symbol);
      const ref = refs.get(symbol);
      const rate = inst.currency === "USD" ? (ref?.eurUsd ?? eurUsd ?? 1) : 1;
      return [{
        symbol, name: inst.name, qty: pos?.qty ?? 0, cost: pos?.cost ?? 0, rate, currency: inst.currency,
        priceEur: ref ? ref.price / (ref.currency === "USD" ? (ref.eurUsd ?? 1) : 1) : null,
        known: this.events?.known ? this.events.known(symbol) : this.events !== undefined,
        dividends: this.events?.dividends(symbol, "2019-01-01", today) ?? [],
        credited: bookings.filter((b) => b.symbol === symbol).map((b) => ({ exDay: b.ref, amount: b.amount })),
      }];
    });
    const metrics = computeMetrics(this.store.valueCurve(depotId, EVALUATION_POINTS));
    return buildCalendar({
      today, startCash: sim.startCash, totalReturn: metrics.totalReturn, titles,
      bookings: bookings.map((b) => ({ exDay: b.ref, amount: b.amount, paidDay: iso(b.t) })),
    });
  }

  /**
   * Dividends, splits and gaps of some titles, from the bars that are finished at the simulation time and not past them.
   * Looks back a year in a daily simulation and the 30 days the minute archive holds otherwise.
   */
  marketEvents(id: number, symbols: string[]): MarketEvent[] {
    const sim = this.sim(id);
    const day = sim.resolution === "day";
    const from = sim.startAt - (day ? 366 : 30) * DAY;
    const out: MarketEvent[] = [];
    for (const symbol of new Set(symbols)) {
      const inst = this.registry.get(symbol);
      if (!inst) continue;
      const bars = day
        ? (this.daily?.between(symbol, from, sim.simulationTime) ?? []).map((b) => ({ t: b.t, o: b.o, c: b.c }))
        : this.archive.barsBetween(symbol, from, sim.simulationTime - 59).map((b) => ({ t: b.t, o: b.o, c: b.c }));
      const fromDay = new Date(from * 1000).toISOString().slice(0, 10);
      const toDay = new Date((sim.simulationTime - 1) * 1000).toISOString().slice(0, 10);
      out.push(...marketEvents({
        symbol, currency: inst.currency, bars,
        dividends: this.events?.dividends(symbol, fromDay, toDay) ?? [],
        splits: this.events?.splits(symbol, fromDay, toDay) ?? [],
      }));
    }
    return out.sort((a, b) => a.day.localeCompare(b.day) || a.symbol.localeCompare(b.symbol) || a.kind.localeCompare(b.kind));
  }

  private lastOpen = new Map<number, Map<string, boolean>>();
  private nearFired = new Set<number>();
  private jumpFired = new Set<string>();

  /** The price an auto-pause rule looks at: the close of the last finished bar (or day) at `s`. */
  private lastClose(symbol: string, s: number, day: boolean): number | undefined {
    return day ? this.daily?.lastComplete(symbol, s)?.c : this.archive.lastCompleteBar(symbol, s, SOUND)?.c;
  }

  /**
   * The reason to stop the clock after a tick, if one of the rules the person switched on applies. Each cause is told once:
   * an order that is near its limit, a jump that is still going on, an opening that already happened do not fire again.
   * A simulation without a pause (the hardcore rules) has no auto-pause either.
   */
  autoPauseFor(id: number, r: TickResult): { rule: AutoPauseRule; reason: string } | null {
    const sim = this.sim(id);
    const p = sim.autoPause;
    const day = sim.resolution === "day";
    const s = r.simulationTime;
    const signals: Signals = { ...(r.signals ?? noSignals()), opened: [], near: [], jumps: [] };

    // Openings are seen against the last look even when no rule asks, so that switching the rule on does not fire at once.
    if (!day) {
      const now = new Map<string, boolean>();
      for (const v of VENUES) if (v.hasSource) now.set(v.id, this.venueOpen(v.id as Venue, s));
      const before = this.lastOpen.get(id);
      this.lastOpen.set(id, now);
      if (before) for (const v of VENUES) if (now.get(v.id) && before.get(v.id) === false) signals.opened.push(`${v.name} hat geöffnet`);
    }
    if (!sim.rules.pauseAllowed) return null;
    if (!(p.onFill || p.onEvent || p.onOpen || p.nearLimit || p.jump)) return null;

    const depots = this.store.listDepots(id).filter((d) => d.kind === "normal").map((d) => this.store.loadDepot(d.id));
    if (p.nearLimit) {
      const open = depots.flatMap((d) => d.orders.filter((o) => o.status === "open" && o.kind === "limit" && o.limitPrice !== undefined));
      const openIds = new Set(open.map((o) => o.id));
      for (const gone of this.nearFired) if (!openIds.has(gone)) this.nearFired.delete(gone);
      for (const o of open) {
        if (this.nearFired.has(o.id)) continue;
        const price = this.lastClose(o.symbol, s, day);
        const dist = price === undefined ? null : distanceToLimit(price, o.limitPrice as number);
        if (dist !== null && dist <= p.nearLimitPct) {
          this.nearFired.add(o.id);
          signals.near.push(`${o.side === "buy" ? "Kauf" : "Verkauf"}-Limit ${o.symbol} ist ${(dist * 100).toFixed(1).replace(".", ",")} % vom Kurs entfernt`);
        }
      }
    }
    if (p.jump && !day) {
      const watched = new Set(depots.flatMap((d) => [...d.positions.keys(), ...d.orders.filter((o) => o.status === "open").map((o) => o.symbol)]));
      for (const symbol of watched) {
        const now = this.lastClose(symbol, s, false);
        const then = this.lastClose(symbol, s - p.jumpMinutes * 60, false);
        const change = now === undefined || then === undefined ? null : jumpOf(now, then, p.jumpPct);
        const key = `${id}:${symbol}`;
        if (change === null) { this.jumpFired.delete(key); continue; }
        if (this.jumpFired.has(key)) continue;
        this.jumpFired.add(key);
        signals.jumps.push(`${symbol} ${change > 0 ? "+" : "−"}${(Math.abs(change) * 100).toFixed(1).replace(".", ",")} % in ${p.jumpMinutes} Minuten`);
      }
    }
    return pauseReason(p, signals);
  }

  /**
   * The end of the next finished bar of any instrument after `s`: the smallest step that shows something new. Over a night or
   * a weekend that is the first bar after the gap. Undefined when the archive has no later bar.
   */
  private nextBarEnd(s: number): number | undefined {
    let end: number | undefined;
    for (const inst of this.instruments) {
      const bar = this.archive.nextBarAfter(inst.symbol, s - 60);
      if (bar && (end === undefined || bar.t + 60 < end)) end = bar.t + 60;
    }
    return end;
  }

  /**
   * Plays the clock to a target in steps of one finished bar and stops on the way when an order executed (it is carried out
   * first, then the clock halts), when an auto-pause rule fires, at the end of the data or of a scenario. The jump arrives at the
   * target to the second, also when the market is shut there. A daily simulation knows one jump, the next trading day.
   * `symbol` names the market whose hours the target follows (the shown symbol); Xetra if none.
   */
  jump(id: number, kind: JumpKind, symbol?: string): JumpResult | { ok: false; reason: string } {
    const sim = this.sim(id);
    if (sim.endedAt !== null) return { ok: false, reason: "Die Simulation ist beendet." };
    if (sim.live) return { ok: false, reason: "Im Livebetrieb gibt es keine Sprünge: Die Zeit ist die Gegenwart." };
    if (!sim.rules.pauseAllowed) return { ok: false, reason: JUMP_REFUSED };

    if (sim.resolution === "day") {
      if (kind !== "candle" && kind !== "day") return { ok: false, reason: "In einer Tageskurs-Simulation gibt es nur „Tag weiter“." };
      const r = this.stepDays(id, 1);
      const ended = this.sim(id).endedAt !== null;
      return {
        ok: true, simulationTime: r.simulationTime, newBars: r.newBars, target: r.simulationTime,
        stopped: ended ? { rule: "end", reason: "Das Szenario ist zu Ende." } : r.endOfData ? { rule: "data", reason: "Ende der Daten: für die Zeit danach gibt es noch keine Kurse." } : null,
      };
    }

    const from = sim.simulationTime;
    const venue = VENUES.find((v) => v.id === (symbol ? this.registry.get(symbol)?.venue : undefined)) ?? VENUES[0];
    let target: number;
    if (kind === "candle") {
      const next = this.nextBarEnd(from);
      if (next === undefined) return { ok: true, simulationTime: from, newBars: {}, target: from, stopped: { rule: "data", reason: "Ende der Daten: für die Zeit danach gibt es noch keine Kurse." } };
      target = next;
    } else {
      const stop = nextStop(kind, from, venue);
      if (stop === undefined) return { ok: false, reason: `${venue.name} hat in den nächsten zwei Wochen keinen Handelstag.` };
      target = Math.min(stop, sim.endAt ?? Infinity);
    }

    return this.playTo(id, target);
  }

  /** Plays the clock on towards `target` in steps of one finished bar; see `jump` for where it stops. */
  playTo(id: number, target: number): JumpResult {
    const sim = this.sim(id);
    const from = sim.simulationTime;
    const merged: Record<string, Bar[]> = {};
    let time = from;
    let stopped: JumpResult["stopped"] = null;
    for (let guard = 0; time < target && guard < 20_000; guard++) {
      const to = Math.min(target, this.nextBarEnd(time) ?? target);
      const r = this.tick(id, 0, to);
      for (const [sym, bars] of Object.entries(r.newBars)) (merged[sym] ??= []).push(...bars);
      const moved = r.simulationTime > time;
      time = r.simulationTime;
      if (this.sim(id).endedAt !== null) { stopped = { rule: "end", reason: "Das Szenario ist zu Ende." }; break; }
      if (r.signals?.fills.length) { stopped = { rule: "fill", reason: `Angehalten: ${r.signals.fills[0]}${r.signals.fills.length > 1 ? ` (und ${r.signals.fills.length - 1} weitere)` : ""}` }; break; }
      const pause = this.autoPauseFor(id, r);
      if (pause) { stopped = pause; break; }
      if (r.endOfData || r.waitingForData || !moved) { stopped = { rule: "data", reason: "Ende der Daten: für die Zeit danach gibt es noch keine Kurse." }; break; }
    }
    return { ok: true, simulationTime: time, newBars: merged, target, stopped };
  }

  /**
   * Rolling figures, calendar months, falls and ranges of a depot's curve and of the benchmark's, on the daily curve and not
   * past the simulation time. The benchmark is a price; the depot's curve holds its distributions.
   */
  rolling(id: number, depotId: number): RollingResult {
    const sim = this.sim(id);
    const points = this.store.valueCurve(depotId, EVALUATION_POINTS);
    const bench = this.benchmarkSeries(sim, EVALUATION_POINTS);
    const inst = sim.benchmark ? this.registry.get(sim.benchmark) : undefined;
    const beta = bench ? rollingBeta(points, bench) : [];
    const step = Math.max(1, Math.ceil(beta.length / 400));
    return {
      simulationTime: sim.simulationTime,
      depot: analyze(points),
      benchmark: bench && inst ? { symbol: inst.symbol, name: inst.name, ...analyze(bench) } : null,
      beta: { window: BETA_WINDOW, points: beta.filter((_, i) => i % step === 0 || i === beta.length - 1) },
    };
  }

  private runCache = new Map<number, RunSummary>();
  private excursionCache = new Map<string, Excursion>();

  /**
   * The round book entry of a simulation. A finished round never changes, so its figures are kept
   * (the evaluation is not cheap) and a later look shows exactly the numbers of the first.
   */
  runSummary(id: number): RunSummary {
    const sim = this.sim(id);
    const cached = this.runCache.get(id);
    if (cached && sim.endedAt !== null && cached.endedAt === sim.endedAt) return cached;
    const ev = this.evaluation(id);
    const depot = this.firstNormal(id);
    const row = ev.depots.find((d) => d.id === depot.id) ?? ev.depots[0];
    const state = this.store.loadDepot(depot.id);
    const finalValue = depotValue(state, this.refsAt(sim.simulationTime, sim.resolution === "day"));
    const journal = this.journal(id, depot.id);
    const filledOrders = state.orders.filter((o) => o.status === "filled").length;
    const benchmarkReturn = ev.benchmark?.metrics.totalReturn ?? null;
    const grade = gradeRun({
      totalReturn: row.metrics.totalReturn, benchmarkReturn, maxDrawdown: row.metrics.maxDrawdown, feeShare: row.fees.shareOfStart,
      hitRate: journal.hitRate.rate, closedTrades: journal.hitRate.n, filledOrders, days: (sim.simulationTime - sim.startAt) / DAY,
    });
    const scenario = this.result(id) ?? null;
    const bench = this.benchmarkSeries(sim, RUN_CURVE_POINTS);
    const out: RunSummary = {
      id, name: sim.name, startAt: sim.startAt, simulationTime: sim.simulationTime, endedAt: sim.endedAt, finished: sim.endedAt !== null,
      preset: sim.rules.preset, resolution: sim.resolution, scenarioId: sim.scenarioId, scenarioTitle: scenario?.title ?? null,
      startCash: sim.startCash, finalValue, totalReturn: row.metrics.totalReturn, benchmarkSymbol: ev.benchmark?.symbol ?? null,
      benchmarkReturn, maxDrawdown: row.metrics.maxDrawdown, fees: row.fees.total, feeShare: row.fees.shareOfStart,
      trades: filledOrders, hitRate: journal.hitRate.rate, closedTrades: journal.hitRate.n, grade, gradeFormula: GRADE_FORMULA, scenario,
      curve: { depot: thin(this.store.valueCurve(depot.id, EVALUATION_POINTS), RUN_CURVE_POINTS), benchmark: bench },
    };
    if (sim.endedAt !== null) this.runCache.set(id, out);
    return out;
  }

  /** The finished rounds, newest first. */
  runs(): RunSummary[] {
    return this.store.listSimulations()
      .filter((s) => s.endedAt !== null)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.id - a.id)
      .map((s) => this.runSummary(s.id));
  }

  /** The benchmark's closing prices from the start to now, in the points of the simulation's own resolution. */
  private benchmarkSeries(sim: Simulation, maxPoints: number): Point[] | null {
    const inst = sim.benchmark ? this.registry.get(sim.benchmark) : undefined;
    if (!inst) return null;
    return thin(
      sim.resolution === "day"
        ? (this.daily?.between(inst.symbol, sim.startAt, sim.simulationTime) ?? []).map((b) => ({ t: b.t + DAY, value: b.c }))
        : this.archive.barsBetween(inst.symbol, sim.startAt - 59, sim.simulationTime - 59).map((b) => ({ t: b.t + 60, value: b.c })),
      maxPoints,
    );
  }

  /** Trades, hit rate, holding time and "too early" of one depot, computed now from its filled orders. */
  journal(id: number, depotId: number): Journal & { bookings: Booking[]; depotId: number; simulationTime: number; behavior: Behavior; excursions: Excursions } {
    const sim = this.sim(id);
    const filled: JournalOrder[] = [];
    for (const o of this.store.loadDepot(depotId).orders) {
      if (o.status !== "filled" || o.filledSim === undefined || o.fillPrice === undefined) continue;
      filled.push({
        id: o.id, symbol: o.symbol, side: o.side, qty: o.qty, fillPrice: o.fillPrice, filledSim: o.filledSim,
        gross: o.gross ?? 0, commission: o.commission ?? 0, foreignFee: o.foreignFee ?? 0,
      });
    }
    const bars = sim.resolution === "day" ? this.dailyBars() : this.archive;
    const { journal, contexts, openLots } = buildJournalCore({ orders: filled, s: sim.simulationTime, bars, notes: this.store.notes(id) });
    const curve = this.store.valueCurve(depotId, EVALUATION_POINTS);
    const meanValue = curve.length === 0 ? null : curve.reduce((a, p) => a + p.value, 0) / curve.length;
    const behavior = analyzeBehavior({
      orders: filled, trades: journal.trades, contexts, s: sim.simulationTime, bars, meanValue, intraday: sim.resolution !== "day",
    });
    const excursions = this.excursions(sim, depotId, journal.trades, openLots);
    return { ...journal, bookings: this.store.bookings(depotId), depotId, simulationTime: sim.simulationTime, behavior, excursions };
  }

  /**
   * MAE, MFE and the benchmark check of the closed trades and the open lots. A closed trade never changes once its buy day is
   * over, so its figures are kept; open lots are worked out again each time.
   */
  private excursions(sim: Simulation, depotId: number, trades: JournalTrade[], openLots: OpenLot[]): Excursions {
    const s = sim.simulationTime;
    const bars = this.excursionBars(sim);
    const bench = sim.benchmark;
    const closed: Record<string, Excursion> = {};
    for (const t of trades) {
      const key = `${depotId}:${t.key}:${bench ?? ""}`;
      const kept = this.excursionCache.get(key);
      if (kept) { closed[t.key] = kept; continue; }
      const e = tradeExcursion(t, s, bars, bench);
      closed[t.key] = e;
      if (s >= Math.floor(t.openedSim / DAY) * DAY + DAY) this.excursionCache.set(key, e);
    }
    const open: OpenExcursion[] = [];
    for (const lot of openLots) {
      const e = openExcursion(lot, s, bars, bench);
      if (e) open.push({ ...e, symbol: lot.symbol, qty: lot.qty, openedSim: lot.openedSim });
    }
    return { benchmark: bench, trades: closed, open, summary: summarize(Object.values(closed)) };
  }

  /** The bars as the excursions read them: minute bars from the archive, or the daily bars of a daily simulation. */
  private excursionBars(sim: Simulation): ExcursionBars {
    if (sim.resolution === "day") {
      const d = this.daily;
      return {
        lastCompleteBar: (symbol, s) => d?.lastComplete(symbol, s),
        nextBarAfter: (symbol, t) => d?.nextAfter(symbol, t),
        barsBetween: (symbol, from, to) => d?.between(symbol, from, to) ?? [],
        barSeconds: DAY,
      };
    }
    const a = this.archive;
    return {
      lastCompleteBar: (symbol, s) => a.lastCompleteBar(symbol, s),
      nextBarAfter: (symbol, t) => a.nextBarAfter(symbol, t),
      barsBetween: (symbol, from, to) => a.barsBetween(symbol, from, to),
      barSeconds: 60,
    };
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
          return { symbol, percent, ref: inst && this.refAt(inst, sim.simulationTime, sim.resolution === "day") };
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
      const bar = sim.resolution === "day" ? this.daily?.lastComplete(inst.symbol, p.t) : this.archive.lastCompleteBar(inst.symbol, p.t, SOUND);
      if (bar) points.push({ t: p.t, value: bar.c });
    }
    return { depots, benchmark: { symbol: inst.symbol, name: inst.name, currency: inst.currency, points } };
  }

  /** Figures per depot, how the depots move together, and the benchmark measured the same way. */
  evaluation(id: number): Evaluation {
    const sim = this.sim(id);
    const refs = this.refsAt(sim.simulationTime, sim.resolution === "day");
    const curves = this.store.listDepots(id).map((d) => ({ depot: d, points: this.store.valueCurve(d.id, EVALUATION_POINTS) }));
    const inst = sim.benchmark ? this.registry.get(sim.benchmark) : undefined;
    const benchSeries = this.benchmarkSeries(sim, EVALUATION_POINTS);
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
        diversification: diversify(this.heldSeries(sim, held, state.positions)),
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

    const day = simulation.resolution === "day";
    const prices: Snapshot["prices"] = {};
    for (const inst of this.instruments) {
      const bar = day ? this.daily?.lastComplete(inst.symbol, s) : this.archive.lastCompleteBar(inst.symbol, s, SOUND);
      if (bar) prices[inst.symbol] = { price: bar.c, barT: bar.t };
    }
    const refs = this.refsAt(s, simulation.resolution === "day");
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
      fx: day ? (this.fxRate?.("USD", isoDay(s - DAY)) ?? null) : (this.archive.lastCompleteBar(this.fx, s, SOUND)?.c ?? null),
      // A daily simulation has no opening hours: every step is a whole day.
      venues: day ? { XETRA: true, US: true } : { XETRA: this.venueOpen("XETRA", s), US: this.venueOpen("US", s) },
      venueClosed: day ? {} : this.holidays(s),
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
  private refsAt(s: number, day = false): Map<string, Ref> {
    const refs = new Map<string, Ref>();
    for (const inst of this.instruments) {
      const ref = this.refAt(inst, s, day);
      if (ref) refs.set(inst.symbol, ref);
    }
    return refs;
  }

  /** The last known price of an instrument, with the exchange rate for USD. */
  private refAt(inst: Instrument, s: number, day = false): Ref | undefined {
    if (day) return this.dayRef(inst, s);
    const bar = this.archive.lastCompleteBar(inst.symbol, s, SOUND);
    if (!bar) return undefined;
    if (inst.currency === "EUR") return { price: bar.c, currency: "EUR" };
    const eurUsd = this.archive.lastCompleteBar(this.fx, s, SOUND)?.c;
    return eurUsd === undefined ? undefined : { price: bar.c, currency: "USD", eurUsd };
  }

  /**
   * The held positions with their prices in EUR from the start of the simulation up to its time and
   * not a minute beyond. A USD price is divided by the rate of the same minute (the last one known).
   */
  private heldSeries(sim: Simulation, held: { symbol: string; value: Cent }[], positions: DepotState["positions"]): HeldSeries[] {
    const from = sim.startAt - 59;
    const to = sim.simulationTime - 59;
    let rates: Map<number, number> | undefined;
    const out: HeldSeries[] = [];
    for (const h of held) {
      if (!positions.has(h.symbol)) continue;
      const inst = this.registry.get(h.symbol);
      if (!inst) continue;
      if (sim.resolution === "day") {
        const points: Point[] = [];
        for (const b of this.daily?.between(h.symbol, sim.startAt, sim.simulationTime) ?? []) {
          const rate = inst.currency === "USD" ? this.fxRate?.("USD", isoDay(b.t)) : 1;
          if (rate !== undefined) points.push({ t: b.t + DAY, value: b.c / rate });
        }
        out.push({ symbol: h.symbol, value: h.value, points });
        continue;
      }
      const blocked = new Set(this.archive.flagsBetween(h.symbol, from, to, BLOCKING_KINDS).map((f) => f.t));
      const bars = this.archive.barsBetween(h.symbol, from, to).filter((b) => !blocked.has(b.t));
      let points: Point[];
      if (inst.currency === "USD") {
        rates ??= new Map(this.archive.barsBetween(this.fx, from, to).map((b) => [b.t, b.c]));
        let last: number | undefined;
        points = [];
        for (const b of bars) {
          last = rates.get(b.t) ?? last;
          if (last !== undefined) points.push({ t: b.t + 60, value: b.c / last });
        }
      } else {
        points = bars.map((b) => ({ t: b.t + 60, value: b.c }));
      }
      out.push({ symbol: h.symbol, value: h.value, points });
    }
    return out;
  }

  /** The daily bars as the journal wants to read them: a bar is finished a day after it begins. */
  private dailyBars() {
    const d = this.daily;
    return {
      lastCompleteBar: (symbol: string, s: number) => d?.lastComplete(symbol, s),
      nextBarAfter: (symbol: string, t: number) => d?.nextAfter(symbol, t),
    };
  }

  /** The close of the last finished day, with the ECB rate of that day for USD. */
  private dayRef(inst: Instrument, s: number): Ref | undefined {
    const bar = this.daily?.lastComplete(inst.symbol, s);
    if (!bar) return undefined;
    if (inst.currency === "EUR") return { price: bar.c, currency: "EUR" };
    const eurUsd = this.fxRate?.("USD", isoDay(bar.t));
    return eurUsd === undefined ? undefined : { price: bar.c, currency: "USD", eurUsd };
  }

  /** Moves the clock by the days that `realMs` is worth at the tempo (days per second). */
  private tickDay(id: number, realMs: number): TickResult {
    const sim = this.sim(id);
    const wanted = (this.carry.get(id) ?? 0) + (realMs / 1000) * sim.tempo;
    const whole = Math.min(Math.floor(wanted), MAX_DAY_STEPS);
    this.carry.set(id, wanted - Math.floor(wanted));
    return this.stepDays(id, whole);
  }

  /**
   * Plays `n` trading days. A day is the next one on which any instrument has a daily bar. Orders see
   * that bar and nothing later: a market order fills at its open, a limit order only if the day goes past
   * the limit (strictly: a low equal to the limit may not have filled), at the limit price. Dividends of
   * the day are booked first, for what was held before it. The time ends on the midnight after the day.
   */
  stepDays(id: number, n: number): TickResult {
    let sim = this.sim(id);
    const newBars: Record<string, Bar[]> = {};
    let endOfData = false;
    for (let k = 0; k < n; k++) {
      const s = sim.simulationTime;
      const next = this.instruments.flatMap((i) => {
        const b = this.daily?.nextAfter(i.symbol, s - 1);
        return b ? [{ symbol: i.symbol, bar: b }] : [];
      });
      if (next.length === 0) { endOfData = true; break; }
      const dayT = Math.min(...next.map((x) => x.bar.t));
      if (sim.endAt !== null && dayT >= sim.endAt) {
        this.store.endSimulation(id);
        endOfData = true;
        break;
      }
      const today = next.filter((x) => x.bar.t === dayT).sort((a, b) => a.symbol.localeCompare(b.symbol));
      const end = dayT + DAY;
      const eventsOf = this.eventsFor(today);
      const fresh = sim;
      this.store.transaction(() => {
        for (const depot of this.store.listDepots(id)) {
          const state = this.store.loadDepot(depot.id);
          let changed = false;
          for (const { symbol, bar } of today) {
            changed = this.bookDayDividends(depot, state, symbol, bar, eventsOf) || changed;
            changed = this.evaluateDay(state, fresh, symbol, bar) || changed;
          }
          if (changed) this.store.saveBalance(depot.id, state.cash, state.positions);
        }
        this.store.setSimulationTime(id, end);
        for (const depot of this.store.listDepots(id)) {
          this.store.recordValue(depot.id, end, depotValue(this.store.loadDepot(depot.id), this.refsAt(end, true)));
        }
      });
      for (const { symbol, bar } of today) (newBars[symbol] ??= []).push(bar);
      sim = this.sim(id);
      // The last day before the end of a scenario ends the simulation.
      if (sim.endAt !== null) {
        const more = this.instruments.some((i) => {
          const b = this.daily?.nextAfter(i.symbol, end - 1);
          return b !== undefined && b.t < sim.endAt!;
        });
        if (!more) {
          this.store.endSimulation(id);
          endOfData = true;
          break;
        }
      }
    }
    return { simulationTime: sim.simulationTime, newBars, endOfData, waitingForData: false, liveEdge: false };
  }

  /** The dividends of one day, booked once per depot for the shares held before the day. */
  private bookDayDividends(
    depot: Depot, state: DepotState & { orders: OrderRecord[] }, symbol: string, bar: Bar, eventsOf: ReturnType<SessionService["eventsFor"]>,
  ): boolean {
    const ev = eventsOf.get(symbol);
    if (!ev || !state.positions.has(symbol)) return false;
    const day = isoDay(bar.t);
    const dividends = ev.dividends.filter((d) => d.exDay === day);
    if (dividends.length === 0) return false;
    const inst = this.registry.get(symbol)!;
    const rate = inst.currency === "USD" ? this.fxRate?.("USD", day) : 1;
    if (rate === undefined) return false;
    return this.creditDividends(depot, state, symbol, bar.t, dividends, rate);
  }

  /** Fills what the bar of a day triggers. True if the depot changed. */
  private evaluateDay(state: DepotState & { orders: OrderRecord[] }, sim: Simulation, symbol: string, bar: Bar): boolean {
    const inst = this.registry.get(symbol)!;
    let changed = false;
    for (const o of state.orders) {
      if (o.status !== "open" || o.symbol !== symbol) continue;
      if (o.kind === "limit" && o.limitPrice !== undefined) {
        const reached = o.side === "buy" ? bar.l < o.limitPrice : bar.h > o.limitPrice;
        if (!reached) continue;
      }
      let ref: Ref;
      if (inst.currency === "EUR") {
        ref = { price: bar.o, currency: "EUR" };
      } else {
        const eurUsd = this.fxRate?.("USD", isoDay(bar.t));
        if (eurUsd === undefined) continue;
        ref = { price: bar.o, currency: "USD", eurUsd };
      }
      const exec = previewCost(o.side, o.qty, ref, o.kind, o.limitPrice, sim.fees);
      const affordable = o.side === "buy"
        ? exec.total <= state.cash
        : (state.positions.get(symbol)?.qty ?? 0) >= o.qty && state.cash + exec.total >= 0;
      if (!affordable) {
        o.status = "rejected";
        this.store.setOrderStatus(o.id, "rejected");
        continue;
      }
      fillOrder(state, o, exec);
      this.store.markFilled(o.id, { filledSim: bar.t, fillPrice: exec.execPrice, gross: exec.gross, commission: exec.commission, foreignFee: exec.foreign });
      this.signals?.fills.push(`${o.side === "buy" ? "Kauf" : "Verkauf"} ${o.qty} ${symbol} ausgeführt`);
      changed = true;
    }
    return changed;
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
    let changed = this.creditDividends(depot, state, symbol, bar.t, dividends, rate);
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
      this.signals?.bookings.push(`Aktiensplit ${symbol} ${sp.numerator}:${sp.denominator} gebucht`);
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

  /** Credits distributions once per depot (the booking table refuses a second write for the same ex-day). */
  private creditDividends(
    depot: Depot, state: DepotState, symbol: string, t: number, dividends: { exDay: string; amount: number }[], rate: number,
  ): boolean {
    let changed = false;
    for (const d of dividends) {
      const qty = state.positions.get(symbol)?.qty ?? 0;
      const amount = dividendCredit(qty, d.amount, rate);
      if (amount <= 0) continue;
      const text = `Ausschüttung ${symbol} ${(amount / 100).toFixed(2).replace(".", ",")} €`;
      if (this.store.addBooking(depot.id, { t, kind: "dividend", symbol, ref: d.exDay, amount, text })) {
        state.cash += amount;
        this.signals?.bookings.push(`Ausschüttung ${symbol} gebucht`);
        changed = true;
      }
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
      this.signals?.fills.push(`${o.side === "buy" ? "Kauf" : "Verkauf"} ${o.qty} ${symbol} ausgeführt`);
      changed = true;
    }
    return changed;
  }
}
