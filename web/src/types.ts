// What the server sends and accepts. Kept by hand next to server/src/session.ts and store.ts:
// the web build must not reach into the server's source.

export type Tempo = 1 | 5 | 30 | 60;
export type Venue = "XETRA" | "US";

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
}

export interface Simulation {
  id: number;
  name: string;
  startAt: number;
  simulationTime: number;
  tempo: Tempo;
  startCash: number;
  createdAt: number;
  endedAt: number | null;
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

export interface DepotView {
  id: number;
  name: string;
  cash: number;
  value: number;
  positions: PositionView[];
  orders: OrderRecord[];
}

export interface Snapshot {
  simulation: Simulation;
  running: boolean;
  depot: DepotView;
  prices: Record<string, { price: number; barT: number }>;
  fx: number | null;
  venues: Record<Venue, boolean>;
}

export type ServerMessage =
  | ({ type: "snapshot" } & Snapshot)
  | {
      type: "tick";
      simulationTime: number;
      newBars: Record<string, Bar[]>;
      running: boolean;
      depot: DepotView;
      prices: Snapshot["prices"];
      fx: number | null;
      venues: Snapshot["venues"];
    }
  | { type: "notice"; text: string }
  | { type: "error"; text: string };

export type ClientMessage = { type: "run" } | { type: "pause" } | { type: "tempo"; tempo: Tempo };
