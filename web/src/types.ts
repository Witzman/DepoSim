// What the server sends and accepts. Kept by hand next to server/src/session.ts and store.ts:
// the web build must not reach into the server's source.

export type Tempo = 1 | 5 | 30 | 60 | 120 | 300;

export type JumpKind = "candle" | "hour" | "close" | "open" | "day";

/** Rules that stop the clock by themselves; all off until the person switches them on. */
export interface AutoPause {
  onFill: boolean;
  nearLimit: boolean;
  nearLimitPct: number;
  jump: boolean;
  jumpPct: number;
  jumpMinutes: number;
  onOpen: boolean;
  onEvent: boolean;
}
export type Venue = "XETRA" | "US";

/** A market the app knows, from GET /api/venues. Only those with `hasSource` can be traded on. */
export interface VenueInfo {
  id: Venue | "FRANKFURT" | "TRADEGATE" | "GETTEX";
  name: string;
  timeZone: string;
  opens: string;
  closes: string;
  hasSource: boolean;
  note: string;
}

export type BackfillStatus = "loaded" | "empty" | "error" | "skipped" | "out_of_range";

/** GET /api/archive/missing */
export interface MissingList {
  days: number;
  daysIsAssumption: boolean;
  reachDays: number;
  blocked: string | null;
  items: { symbol: string; day: string; dayStart: number; state: "never" | "incomplete"; inReach: boolean }[];
}

/** The report of a finished backfill (inside BackfillJob.report). */
export interface BackfillReport {
  days: number;
  daysIsAssumption: boolean;
  stoppedByRateLimit: boolean;
  counts: { loaded: number; empty: number; error: number; skipped: number; outOfRange: number };
  items: { symbol: string; day: string; dayStart: number; status: BackfillStatus; label: string; bars?: number; reason?: string }[];
}

/**
 * POST /api/archive/backfill, body { days?: number }, answers 202 with the job (409 { error } if refused).
 * GET /api/archive/backfill answers the current or last job; before any run: running false, startedAt null, done 0, total 0.
 */
export interface BackfillJob {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  done: number;
  total: number;
  report: BackfillReport | null;
  /** Only when the run broke off on an unexpected error. */
  error?: string;
}

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Marked as an outlier by the plausibility check (#50): drawn hollow, not traded on. */
  flagged?: boolean;
}

export interface Instrument {
  symbol: string;
  name: string;
  currency: "EUR" | "USD";
  venue: Venue;
  /** True for the ones the person added; only those can be removed. */
  added?: boolean;
}

export type SearchHit = Instrument & { known: boolean };

export interface Simulation {
  id: number;
  name: string;
  startAt: number;
  simulationTime: number;
  tempo: Tempo;
  startCash: number;
  createdAt: number;
  endedAt: number | null;
  /** Catches up to the present by itself and then follows real time; the tempo is not the person's to set. */
  live: boolean;
  /** The symbol the curves are measured against, if one was chosen. */
  benchmark: string | null;
  rules: Rules;
  /** `day`: one step is a trading day (daily prices); tempo is days per second. */
  resolution: "minute" | "day";
  /** The scenario it plays, if any; the clock stops at `endAt`. */
  scenarioId: string | null;
  endAt: number | null;
  autoPause: AutoPause;
}

export interface ScenarioGoal {
  role: "main" | "bonus";
  kind: "endValue" | "beatBenchmark" | "maxDrawdown" | "fees";
}

export interface Scenario {
  id: string;
  title: string;
  story: string;
  difficulty: "leicht" | "mittel" | "schwer";
  resolution: "minute" | "day";
  startAt: number;
  endAt: number;
  startCash: number;
  preset: "relaxed" | "realistic" | "hardcore";
  symbols: string[];
  benchmark: string | null;
  goals: ScenarioGoal[];
}

export interface GoalResult {
  kind: ScenarioGoal["kind"];
  role: "main" | "bonus";
  label: string;
  met: boolean;
  /** What was reached, in words with the real number, or "—". */
  actual: string;
}

export interface ScenarioResult {
  scenarioId: string;
  title: string;
  finished: boolean;
  stars: number;
  goals: GoalResult[];
}

export interface RollPoint { t: number; vol: number | null; sharpe: number | null; ret: number }
export interface MonthReturn { month: string; ret: number }
export interface Analysis {
  rolling: { window: number; points: RollPoint[] }[];
  months: MonthReturn[];
  years: { year: string; ret: number; months: MonthReturn[] }[];
  episodes: { peakT: number; troughT: number; endT: number | null; depth: number; days: number; ongoing: boolean }[];
  ranges: { days: number; windows: number; positiveShare: number | null }[];
  days: number;
}

/** GET /api/simulations/:id/rolling?depotId= */
export interface RollingResult {
  simulationTime: number;
  depot: Analysis;
  benchmark: (Analysis & { symbol: string; name: string }) | null;
  beta: { window: number; points: { t: number; beta: number | null; corr: number | null }[] };
}

/** GET /api/simulations/:id/events?symbols= : dividends, splits and gaps, up to the simulation time. */
export interface MarketEvent {
  key: string;
  kind: "dividend" | "split" | "gap";
  symbol: string;
  day: string;
  /** Time of the first bar of the day, where a marker sits; null when no bar of that day is known. */
  t: number | null;
  text: string;
}

/** GET /api/simulations/:id/dividends */
export interface DividendCalendar {
  today: string;
  lines: {
    symbol: string;
    name: string;
    qty: number;
    known: boolean;
    past: { exDay: string; perShare: number; currency: "EUR" | "USD"; credited: number | null; source: "Yahoo" }[];
    last12mPerShare: number | null;
    yield12m: number | null;
    yieldOnCost: number | null;
    expectedYear: number | null;
    months: number[];
    pattern: string | null;
  }[];
  income: { total: number; count: number; byYear: { year: string; amount: number }[]; byMonth: { month: string; amount: number }[] };
  returnSplit: { fromDistributions: number; fromPrice: number | null; total: number | null };
  note: string;
}

export type GradeLetter = "A" | "B" | "C" | "D" | "E";

export interface GradePart {
  key: "return" | "risk" | "costs" | "hits";
  label: string;
  score: number;
  weight: number;
  detail: string;
}

/** GET /api/runs and /api/simulations/:id/run: a round with its figures, grade and a thinned curve for the card. */
export interface RunSummary {
  id: number;
  name: string;
  startAt: number;
  simulationTime: number;
  endedAt: number | null;
  finished: boolean;
  preset: RulePreset;
  resolution: "minute" | "day";
  scenarioId: string | null;
  scenarioTitle: string | null;
  startCash: number;
  finalValue: number;
  totalReturn: number | null;
  benchmarkSymbol: string | null;
  benchmarkReturn: number | null;
  maxDrawdown: number | null;
  fees: number;
  feeShare: number;
  trades: number;
  hitRate: number | null;
  closedTrades: number;
  grade: { grade: GradeLetter | null; score: number | null; parts: GradePart[]; note: string | null };
  gradeFormula: string;
  scenario: ScenarioResult | null;
  curve: { depot: { t: number; value: number }[]; benchmark: { t: number; value: number }[] | null };
}

export type RulePreset = "relaxed" | "realistic" | "hardcore" | "custom";

/** Chosen when the simulation is made and never changed. */
export interface Rules {
  preset: RulePreset;
  spreadFactor: number;
  feeFactor: number;
  pauseAllowed: boolean;
  tempoLocked: boolean;
  allowFork: boolean;
  maxPositions: number | null;
}

export interface OrderRecord {
  id: number;
  symbol: string;
  side: "buy" | "sell";
  kind: "market" | "limit";
  qty: number;
  limitPrice?: number;
  status: "open" | "filled" | "cancelled" | "rejected";
  createdSim: number;
  filledSim?: number;
  fillPrice?: number;
  gross?: number;
  commission?: number;
  foreignFee?: number;
}

export interface PositionView {
  symbol: string;
  qty: number;
  cost: number;
  value: number;
}

/** A ghost is a frozen copy of a depot (POST /api/simulations/:id/depots/:depotId/ghost); it never trades. */
export type DepotKind = "normal" | "ghost";

export interface Depot {
  id: number;
  simulationId: number;
  name: string;
  cash: number;
  kind: DepotKind;
}

export interface CurvePoint {
  t: number;
  value: number;
}

export interface Curve {
  id: number;
  name: string;
  kind: DepotKind;
  points: CurvePoint[];
}

export interface BenchmarkCurve {
  symbol: string;
  name: string;
  currency: "EUR" | "USD";
  points: CurvePoint[];
}

export interface Curves {
  depots: Curve[];
  benchmark: BenchmarkCurve | null;
}

export type Basis = "day" | "hour" | "5min";

export interface Metrics {
  basis: Basis | null;
  periodsPerYear: number | null;
  totalReturn: number | null;
  volatility: number | null;
  maxDrawdown: number | null;
  sharpe: number | null;
  /** Like Sharpe, but only falling steps count as risk. */
  sortino: number | null;
  /** Annualized return over the maximum drawdown. */
  calmar: number | null;
  /** The loss one step in twenty reaches (negative ratio per step of `basis`). */
  var95: number | null;
  bestStep: number | null;
  worstStep: number | null;
  /** Share of steps that gained, 0 to 1. */
  upShare: number | null;
  unavailable?: string;
}

/** A depot's steps against the benchmark's; GET /api/simulations/:id/evaluation, per depot, when a benchmark is set. */
export interface Relative {
  basis: Basis;
  beta: number | null;
  alpha: number | null;
  trackingError: number | null;
  informationRatio: number | null;
  hitShare: number;
}

export interface Slice {
  label: string;
  value: number;
  share: number;
}

export interface Hint {
  rule: string;
  severity: "info" | "warn";
  text: string;
  measure: number;
  threshold: number;
  unit: "share" | "count" | "none";
  /** Id of the glossary entry that explains it. */
  why: string;
}

export interface HintRule {
  rule: string;
  label: string;
  unit: "share" | "count" | "none";
  defaults: number[];
  enabled: boolean;
  levels: number[];
  hidden: boolean;
}

export interface HintsResult {
  depotId: number;
  simulationTime: number;
  hints: Hint[];
  hiddenCount: number;
  rules: HintRule[];
}

export interface Diversification {
  concentration: {
    weights: { symbol: string; weight: number }[];
    largest: number;
    top3: number;
    hhi: number;
    effectiveCount: number;
  };
  /** Null, with `reason`, when there are too few common values or only one position. */
  measured: {
    basis: Basis;
    n: number;
    until: number;
    symbols: string[];
    matrix: number[][];
    lines: { symbol: string; weight: number; volatility: number; riskShare: number }[];
    volatility: number;
    ratio: number;
    left: string[];
    remarks: string[];
  } | null;
  reason?: string;
}

export interface Evaluation {
  depots: {
    id: number;
    name: string;
    kind: DepotKind;
    startedAt: number;
    metrics: Metrics;
    vsBenchmark: Relative | null;
    fees: { orders: number; commission: number; foreign: number; total: number; shareOfStart: number };
    breakdown: { sector: Slice[]; country: Slice[]; currency: Slice[] };
    /** Null without positions. */
    diversification: Diversification | null;
  }[];
  correlation: { ids: number[]; basis: Basis | null; matrix: (number | null)[][] };
  benchmark: { symbol: string; name: string; metrics: Metrics } | null;
  note: string;
}

export interface AllocationLine {
  symbol: string;
  percent: number;
  qty: number;
  total: number;
  skipped?: string;
}

export interface DepotView {
  id: number;
  name: string;
  kind: DepotKind;
  cash: number;
  value: number;
  positions: PositionView[];
  orders: OrderRecord[];
}

/** What the server says an order would cost; `total` is cash out for a buy, cash in for a sell. */
export interface CostPreview {
  execPrice: number;
  fxRateEff?: number;
  gross: number;
  commission: number;
  foreign: number;
  total: number;
}

export interface OrderInput {
  symbol: string;
  side: "buy" | "sell";
  kind: "market" | "limit";
  qty: number;
  limitPrice?: number;
  /** The depot the order is for; the first one when left out. */
  depotId?: number;
}

export interface Snapshot {
  simulation: Simulation;
  running: boolean;
  depots: DepotView[];
  prices: Record<string, { price: number; barT: number }>;
  fx: number | null;
  venues: Record<Venue, boolean>;
  /** Per market: the German reason ("Feiertag: Karfreitag") when the calendar shuts the whole day. */
  venueClosed?: Partial<Record<Venue, string>>;
  /** The latest simulation time that may be shown: the present minus the delay. */
  liveLimit: number;
  delayS: number;
  phase: "replay" | "catchup" | "live";
}

export type ServerMessage =
  | ({ type: "snapshot" } & Snapshot)
  | {
      type: "tick";
      simulationTime: number;
      newBars: Record<string, Bar[]>;
      running: boolean;
      depots: DepotView[];
      prices: Snapshot["prices"];
      fx: number | null;
      venues: Snapshot["venues"];
      venueClosed?: Snapshot["venueClosed"];
      liveLimit: number;
      delayS: number;
      phase: Snapshot["phase"];
    }
  | { type: "notice"; text: string }
  | { type: "paused"; rule: string; reason: string }
  | { type: "error"; text: string };

export type ClientMessage =
  | { type: "run" } | { type: "pause" } | { type: "step" } | { type: "tempo"; tempo: Tempo }
  | { type: "jump"; to: JumpKind; symbol?: string };

/** GET /api/simulations/:id/journal?depotId= (default: the first normal depot; 400 for a ghost, 404 unknown). */
export interface JournalTrade {
  /** "<sellOrderId>:<buyOrderId>", the key for PUT /api/simulations/:id/journal/:key. */
  key: string;
  symbol: string;
  qty: number;
  buyOrderId: number;
  sellOrderId: number;
  openedSim: number;
  closedSim: number;
  holdSeconds: number;
  buyPrice: number;
  sellPrice: number;
  buyCost: number;
  sellProceeds: number;
  fees: number;
  netPnl: number;
  netPct: number | null;
  note: string | null;
}

export interface JournalHorizon {
  days: 1 | 5;
  status: "done" | "open";
  laterClose?: number;
  movePct?: number;
  tooEarly?: boolean;
}

export interface JournalSale {
  orderId: number;
  symbol: string;
  qty: number;
  soldSim: number;
  price: number;
  horizons: JournalHorizon[];
}

/** The behaviour card of the journal: patterns in how the trades were made, every figure with its sample size. */
export interface Behavior {
  minTrades: number;
  trades: number;
  disposition: {
    realizedGains: number; realizedLosses: number; paperGains: number; paperLosses: number;
    pgr: number | null; plr: number | null; ratio: number | null; unpriced: number; n: number; ok: boolean;
  };
  holding: { winners: { n: number; medianSeconds: number | null }; losers: { n: number; medianSeconds: number | null }; ok: boolean };
  turnover: { orders: number; ordersPerMonth: number | null; yearlyTurnover: number | null; feesPerTrade: number | null; feeShare: number | null; ok: boolean };
  chasing: { n: number; momentum: number; pullback: number; momentumShare: number | null; pullbackShare: number | null; ok: boolean };
  afterLoss: { n: number; medianGapSeconds: number | null; baselineGapSeconds: number | null; medianSize: number | null; baselineSize: number | null; ok: boolean };
  timeOfDay: { hours: { hour: number; n: number; wins: number; netPnl: number }[]; ok: boolean; reason: string | null };
  note: string;
}

export interface Journal {
  depotId: number;
  behavior: Behavior;
  simulationTime: number;
  trades: JournalTrade[];
  hitRate: { n: number; wins: number; rate: number | null; basis: string };
  holding: { n: number; medianSeconds: number | null; meanSeconds: number | null; basis: string };
  open: { symbol: string; qty: number; cost: number; openedSim: number }[];
  /** Distributions and splits booked to the depot, oldest first. */
  bookings: { t: number; kind: "dividend" | "split"; symbol: string; ref: string; amount: number; text: string }[];
  sales: JournalSale[];
  tooEarly: { days: 1 | 5; n: number; open: number; count: number; rate: number | null; avgMovePct: number | null; basis: string }[];
  /** Under 5 trades: show "wenig Daten". */
  fewData: boolean;
  /** "Beobachtung, keine Prognose." */
  note: string;
}

/** PUT /api/simulations/:id/journal/:key, body { text } (max 500 characters, empty deletes); answers { tradeKey, text }. */
export interface JournalNoteResult {
  tradeKey: string;
  text: string;
}

/** GET /api/simulations/compare?ids=1,2,3 (2 to 4 distinct ids; 404 { error } for an unknown one, 400 otherwise). */
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
    /** Percent from the depot's first point, at most 400 points, on this simulation's own time axis. */
    points: { t: number; pct: number }[];
    figures: {
      returnPct: number | null;
      /** 0 or negative, percent. */
      maxDrawdownPct: number | null;
      /** Commission plus foreign fee, in cents. */
      fees: number;
      /** Filled orders. */
      trades: number;
    };
  }[];
}

export interface CompareResult {
  simulations: Comparison[];
  note: string;
}

/** GET /api/simulations/:id/orderbook?symbol= (400 for an unknown symbol). Display only; always labelled as simulated. */
export type Orderbook =
  | {
      available: true;
      simulated: true;
      /** "SIMULIERT, keine echten Tiefendaten, aus der Kerze abgeleitet" */
      label: string;
      symbol: string;
      currency: "EUR" | "USD";
      /** End of the candle the book is drawn from. */
      asOf: number;
      mid: number;
      tick: number;
      halfSpread: number;
      /** Nearest to the mid first. */
      asks: { price: number; size: number }[];
      bids: { price: number; size: number }[];
    }
  | { available: false; simulated: true; label: string; symbol: string; reason: string };

/** GET /api/longterm. Money is in cent, `curve` is [day "YYYY-MM-DD", value in cent]. */
export interface LongtermTotals {
  firstBuyDay: string | null;
  lastDay: string | null;
  startCash: number;
  finalValue: number;
  /** Ratio: 1.3 means +130 %. */
  totalReturn: number;
  dividendsReceived: number;
  reinvestments: number;
  skippedReinvestments: number;
  feesPaid: number;
  spreadPaid: number;
  leftoverCash: number;
  shares: number;
}

export interface LongtermDepot {
  key: string;
  index: string;
  symbol: string;
  etf: string;
  totals: LongtermTotals;
  curve: [string, number][];
  dividendEvents: number;
  /** Only for an ETF quoted in a foreign currency: where the conversion rate comes from. */
  currency?: string;
  fx?: { currency: string; source: "ecb"; label: string; lastRateDay: string; stale: boolean };
}

export type Longterm =
  | { ready: true; startDay: string; startCash: number; depots: LongtermDepot[] }
  | { ready: false; missing: { symbol: string; reason: string }[] };

export interface LongtermJob {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  done: number;
  total: number;
  items: { symbol: string; status: "loaded" | "current" | "error" | "skipped"; label: string; bars?: number; dividends?: number; reason?: string }[];
  stoppedByRateLimit: boolean;
  error?: string;
}

export interface BackupStatus {
  enabled: boolean;
  dir: string | null;
  keep: number;
  /** UTC seconds of the newest daily backup. */
  lastAt: number | null;
  lastName: string | null;
  lastBytes: number | null;
  error: { at: number; message: string } | null;
  log: { at: number; ok: boolean; text: string }[];
}

// ---- Datenzustand (#49) ----

export type CellState = "complete" | "partial" | "empty" | "never" | "closed";

export interface DataCell {
  day: string;
  state: CellState;
  bars: number;
  expected: number | null;
  thin: boolean;
  today: boolean;
  reason?: string;
}

export interface CoverageRow {
  symbol: string;
  name: string;
  venue: string;
  kind: "EQUITY" | "ETF" | "FX";
  cells: DataCell[];
}

export interface Coverage {
  days: string[];
  reachDays: number;
  rows: CoverageRow[];
  gapCells: number;
}

export interface GapReport {
  symbol: string;
  day: string;
  open: boolean;
  reason?: string;
  windowFrom: number | null;
  windowTo: number | null;
  expected: number;
  bars: number;
  missingMinutes: number;
  gaps: { from: number; to: number; minutes: number }[];
  truncated: boolean;
  hint: string;
}

export type Light = "green" | "yellow" | "red";

export interface DataStatus {
  level: Light;
  reasons: { level: Light | "info"; text: string }[];
  lastCollectionAt: number | null;
  gapCells: number;
  rateLimited24h: number;
}

export type CallKind = "200" | "404" | "422" | "429" | "error";

export interface SourceSummary {
  source: string;
  label: string;
  counts: Record<CallKind, number>;
  calls: number;
  meanMs: number | null;
  lastOkAt: number | null;
  lastAt: number | null;
}

export type FlagKind = "struct" | "spike" | "daily" | "dup" | "time";

export interface FlagReport {
  counts: Record<FlagKind, number>;
  bySymbol: { symbol: string; spike: number; daily: number; other: number }[];
  spikeShare: number;
  flags: { symbol: string; t: number; kind: FlagKind; detail: string; label: string }[];
  truncated: boolean;
}

export interface ArchiveInfo {
  rows: { bars: number; dailyBars: number; fetchedDays: number };
  flags: Record<FlagKind, number>;
  fileBytes: number;
  weeks: { weekStart: string; bars: number; estimatedBytes: number }[];
  bytesPerBar: number | null;
  lastBackupAt: number | null;
  backupEnabled: boolean;
}

export interface JobRun {
  id: number;
  job: string;
  trigger: "plan" | "hand";
  startedAt: number;
  finishedAt: number | null;
  status: string;
  label: string;
  message: string | null;
  error: string | null;
}

export interface JobInfo {
  name: string;
  label: string;
  schedule: string;
  enabled: boolean;
  nextAt: number | null;
  running: boolean;
  queued: boolean;
  lastRun: JobRun | null;
}

export interface JobsOverview {
  enabled: boolean;
  jobs: JobInfo[];
  runs: JobRun[];
}
