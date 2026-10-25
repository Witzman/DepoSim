// What the server sends and accepts. Kept by hand next to server/src/session.ts and store.ts:
// the web build must not reach into the server's source.

export type Tempo = 1 | 5 | 30 | 60;
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
  | { type: "error"; text: string };

export type ClientMessage = { type: "run" } | { type: "pause" } | { type: "tempo"; tempo: Tempo };

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

export interface Journal {
  depotId: number;
  simulationTime: number;
  trades: JournalTrade[];
  hitRate: { n: number; wins: number; rate: number | null; basis: string };
  holding: { n: number; medianSeconds: number | null; meanSeconds: number | null; basis: string };
  open: { symbol: string; qty: number; cost: number; openedSim: number }[];
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
