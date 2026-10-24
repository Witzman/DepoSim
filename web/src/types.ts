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

/** POST /api/archive/backfill, body { days?: number } */
export interface BackfillReport {
  days: number;
  daysIsAssumption: boolean;
  stoppedByRateLimit: boolean;
  counts: { loaded: number; empty: number; error: number; skipped: number; outOfRange: number };
  items: { symbol: string; day: string; dayStart: number; status: BackfillStatus; label: string; bars?: number; reason?: string }[];
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

export interface Depot {
  id: number;
  simulationId: number;
  name: string;
  cash: number;
}

export interface CurvePoint {
  t: number;
  value: number;
}

export interface Curve {
  id: number;
  name: string;
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
  unavailable?: string;
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
    startedAt: number;
    metrics: Metrics;
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
      liveLimit: number;
      delayS: number;
      phase: Snapshot["phase"];
    }
  | { type: "notice"; text: string }
  | { type: "error"; text: string };

export type ClientMessage = { type: "run" } | { type: "pause" } | { type: "tempo"; tempo: Tempo };
