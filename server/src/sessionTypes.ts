import type { Instrument, Venue } from "./config.js";
import type { Bar } from "./data/marketdata.js";
import type { Breakdown, FeeLedger } from "./domain/breakdown.js";
import type { Signals, AutoPauseRule } from "./domain/autopause.js";
import type { Diversification } from "./domain/diversification.js";
import type { Excursion, ExcursionSummary } from "./domain/excursions.js";
import type { CostPreview } from "./domain/fees.js";
import type { GoalOutcome } from "./domain/scenario.js";
import type { Grade } from "./domain/grade.js";
import type { Hint, HintRule } from "./domain/hints.js";
import type { Analysis, BetaPoint } from "./domain/rolling.js";
import type { Correlation, Metrics, Point, Relative } from "./domain/metrics.js";
import type { Cent } from "./domain/money.js";
import type { FundType } from "./domain/taxrules.js";
import type { YearTax } from "./domain/tax.js";
import type { InstrumentRegistry } from "./instruments.js";
import type { Archive } from "./data/archive.js";
import type { DailyArchive } from "./data/dailyarchive.js";
import type { Events } from "./events.js";
import type { DepotKind, OrderRecord, Simulation, Store } from "./store.js";

/** The shapes the session service takes in and gives out. Moved out of `session.ts`, which re-exports them. */

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

export interface TaxReport {
  settings: Simulation["tax"];
  enabled: boolean;
  rules: { asOf: string; rate: number; church: number[]; allowance: number; allowanceIsDefault: boolean; sources: string[] };
  vorabpauschale: { computed: false; reason: string };
  funds: { symbol: string; name: string; type: FundType; isDefault: boolean }[];
  /** Null while the view is off. */
  report: {
    years: YearTax[];
    total: Cent;
    curve: { t: number; gross: Cent; net: Cent }[];
    gross: Pick<Metrics, "totalReturn" | "volatility" | "sharpe" | "maxDrawdown" | "basis">;
    net: Pick<Metrics, "totalReturn" | "volatility" | "sharpe" | "maxDrawdown" | "basis">;
    friction: { fees: Cent; tax: Cent; before: Cent; share: number | null };
    hold: { tax: Cent; difference: Cent; gain: Cent };
  } | null;
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


export interface HintsResult {
  depotId: number;
  simulationTime: number;
  hints: Hint[];
  /** Hints that apply but were hidden by the person. */
  hiddenCount: number;
  rules: { rule: HintRule; label: string; unit: "share" | "count" | "none"; defaults: number[]; enabled: boolean; levels: number[]; hidden: boolean }[];
}

export type PlaceResult = { ok: true; orderId: number } | { ok: false; reason: string };

/** `problem` is why the order would be rejected; the cost is shown anyway. */
export type PreviewResult = { ok: true; cost: CostPreview; problem?: string; notes?: string[] } | { ok: false; reason: string };
