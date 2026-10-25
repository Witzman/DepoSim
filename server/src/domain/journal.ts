import type { Bar } from "../data/marketdata.js";
import { type Cent, roundCent } from "./money.js";

const DAY = 86400;
const dayOf = (t: number) => Math.floor(t / DAY) * DAY;

/** The part of the archive the journal reads. Passed in so the module stays pure and testable. */
export interface BarsAccess {
  /** The last bar finished at `s` (same meaning as `Archive.lastCompleteBar`). */
  lastCompleteBar(symbol: string, s: number): Bar | undefined;
  /** The first bar that starts after `t` (same meaning as `Archive.nextBarAfter`). */
  nextBarAfter(symbol: string, t: number): Bar | undefined;
}

/** A filled order as the store keeps it. Amounts are EUR cents as the broker booked them (USD already converted). */
export interface JournalOrder {
  id: number;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  /** In the instrument's own currency. */
  fillPrice: number;
  filledSim: number;
  gross: Cent;
  commission: Cent;
  foreignFee: Cent;
}

export interface JournalTrade {
  /** `<sellOrderId>:<buyOrderId>`: stable, as orders never change once filled. */
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
  /** What the shares cost with their share of the buy fees. */
  buyCost: Cent;
  /** What they brought in after their share of the sell fees. */
  sellProceeds: Cent;
  /** Commission and foreign fee of both sides, shared by quantity. */
  fees: Cent;
  netPnl: Cent;
  /** Net result over buy cost, in percent; null if the cost is 0. */
  netPct: number | null;
  note: string | null;
}

export type HorizonStatus = "done" | "open";

export interface Horizon {
  days: 1 | 5;
  status: HorizonStatus;
  /** Close of the last bar of the trading day `days` after the sale. Only when done. */
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
  horizons: Horizon[];
}

export interface TooEarlyStat {
  days: 1 | 5;
  /** Sales whose horizon is reached; the rate rests on these. */
  n: number;
  /** Sales whose horizon is not reached yet; they are left out. */
  open: number;
  count: number;
  rate: number | null;
  avgMovePct: number | null;
  basis: string;
}

export interface OpenPosition {
  symbol: string;
  qty: number;
  cost: Cent;
  /** When the oldest remaining lot was bought. */
  openedSim: number;
}

export interface Journal {
  trades: JournalTrade[];
  hitRate: { n: number; wins: number; rate: number | null; basis: string };
  holding: { n: number; medianSeconds: number | null; meanSeconds: number | null; basis: string };
  open: OpenPosition[];
  sales: JournalSale[];
  tooEarly: TooEarlyStat[];
  fewData: boolean;
  note: string;
}

/** What stood when a sale was made: the pieces it closed and every lot still open, for the behaviour analysis. */
export interface SaleContext {
  orderId: number;
  symbol: string;
  soldSim: number;
  closed: { buyPrice: number; sellPrice: number; qty: number }[];
  /** In the instrument's own currency, as all prices of the journal are. */
  remaining: { symbol: string; qty: number; buyPrice: number }[];
}

export const MIN_TRADES = 5;
/** Later close above sale price times this counts as "too early". */
export const TOO_EARLY_FACTOR = 1.02;
const HORIZONS = [1, 5] as const;

const NOTE = "Beobachtung, keine Prognose.";

interface Lot {
  order: JournalOrder;
  qty: number;
  cost: Cent;
  /** Commission and foreign fee still to be shared out. */
  fees: Cent;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** `part` of `whole` units out of a remainder: the last piece takes what is left, so nothing is lost to rounding. */
const share = (remaining: Cent, remainingQty: number, take: number): Cent =>
  take >= remainingQty ? remaining : roundCent((remaining * take) / remainingQty);

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * The close of the trading day `days` after the sale day, from bars finished at `s` only.
 * A trading day is a UTC day with a bar. The horizon is reached when that whole day has passed
 * (`s` at or after its end), so a day that is still running is "open" and no later bar is read.
 */
function laterClose(bars: BarsAccess, symbol: string, soldSim: number, days: number, s: number): Bar | undefined {
  let day = dayOf(soldSim);
  for (let i = 0; i < days; i++) {
    const next = bars.nextBarAfter(symbol, day + DAY - 1);
    if (!next || next.t + 60 > s) return undefined; // not known at s: never look past the clock
    day = dayOf(next.t);
  }
  if (s < day + DAY) return undefined;
  const bar = bars.lastCompleteBar(symbol, Math.min(day + DAY, s));
  return bar && bar.t >= day && bar.t + 60 <= s ? bar : undefined;
}

interface JournalInput {
  orders: JournalOrder[];
  /** The simulation time. Nothing after it is read. */
  s: number;
  bars: BarsAccess;
  notes: Record<string, string>;
}

export function buildJournal(input: JournalInput): Journal {
  return buildJournalCore(input).journal;
}

/** The journal and, per sale, what stood at that moment. One FIFO pass serves both. */
export function buildJournalCore(input: JournalInput): { journal: Journal; contexts: SaleContext[] } {
  const { s, bars, notes } = input;
  const contexts: SaleContext[] = [];
  const orders = [...input.orders].sort((a, b) => a.filledSim - b.filledSim || a.id - b.id);

  const lots = new Map<string, Lot[]>();
  const trades: JournalTrade[] = [];
  const sales: JournalSale[] = [];

  for (const o of orders) {
    const buyCost = o.gross + o.commission + o.foreignFee;
    if (o.side === "buy") {
      const queue = lots.get(o.symbol) ?? [];
      queue.push({ order: o, qty: o.qty, cost: buyCost, fees: o.commission + o.foreignFee });
      lots.set(o.symbol, queue);
      continue;
    }
    const queue = lots.get(o.symbol) ?? [];
    let toSell = o.qty;
    let proceeds = o.gross - o.commission - o.foreignFee;
    let sellFees = o.commission + o.foreignFee;
    let sellLeft = o.qty;
    let sold = 0;
    const closed: SaleContext["closed"] = [];
    while (toSell > 0 && queue.length > 0) {
      const lot = queue[0];
      const take = Math.min(toSell, lot.qty);
      const cost = share(lot.cost, lot.qty, take);
      const out = share(proceeds, sellLeft, take);
      const outFees = share(sellFees, sellLeft, take);
      const buyFees = share(lot.fees, lot.qty, take);
      const net = out - cost;
      trades.push({
        key: `${o.id}:${lot.order.id}`,
        symbol: o.symbol,
        qty: take,
        buyOrderId: lot.order.id,
        sellOrderId: o.id,
        openedSim: lot.order.filledSim,
        closedSim: o.filledSim,
        holdSeconds: o.filledSim - lot.order.filledSim,
        buyPrice: lot.order.fillPrice,
        sellPrice: o.fillPrice,
        buyCost: cost,
        sellProceeds: out,
        fees: outFees + buyFees,
        netPnl: net,
        netPct: cost === 0 ? null : round2((net / cost) * 100),
        note: notes[`${o.id}:${lot.order.id}`] ?? null,
      });
      closed.push({ buyPrice: lot.order.fillPrice, sellPrice: o.fillPrice, qty: take });
      lot.qty -= take;
      lot.cost -= cost;
      lot.fees -= buyFees;
      proceeds -= out;
      sellFees -= outFees;
      sellLeft -= take;
      toSell -= take;
      sold += take;
      if (lot.qty === 0) queue.shift();
    }
    if (sold > 0) {
      contexts.push({
        orderId: o.id, symbol: o.symbol, soldSim: o.filledSim, closed,
        remaining: [...lots.values()].flatMap((q) => q.filter((l) => l.qty > 0).map((l) => ({ symbol: l.order.symbol, qty: l.qty, buyPrice: l.order.fillPrice }))),
      });
      sales.push({
        orderId: o.id, symbol: o.symbol, qty: sold, soldSim: o.filledSim, price: o.fillPrice,
        horizons: HORIZONS.map((days): Horizon => {
          const bar = laterClose(bars, o.symbol, o.filledSim, days, s);
          if (!bar) return { days, status: "open" };
          const movePct = round2((bar.c / o.fillPrice - 1) * 100);
          return {
            days, status: "done", laterClose: bar.c,
            movePct: Number.isFinite(movePct) ? movePct : undefined,
            tooEarly: bar.c > o.fillPrice * TOO_EARLY_FACTOR,
          };
        }),
      });
    }
  }

  const wins = trades.filter((t) => t.netPnl > 0).length;
  const holds = trades.map((t) => t.holdSeconds);
  const tooEarly = HORIZONS.map((days): TooEarlyStat => {
    const hs = sales.map((x) => x.horizons.find((h) => h.days === days)!);
    const done = hs.filter((h) => h.status === "done");
    const moves = done.flatMap((h) => (h.movePct === undefined ? [] : [h.movePct]));
    return {
      days,
      n: done.length,
      open: hs.length - done.length,
      count: done.filter((h) => h.tooEarly).length,
      rate: done.length === 0 ? null : done.filter((h) => h.tooEarly).length / done.length,
      avgMovePct: moves.length === 0 ? null : round2(mean(moves)!),
      basis:
        `Verkäufe, deren ${days}. Handelstag danach vorbei ist; Schlusskurs des Tages gegen den Verkaufspreis, ` +
        `zu früh heißt mehr als 2 % höher; nur Kerzen bis zur Simulationszeit.`,
    };
  });

  const open: OpenPosition[] = [];
  for (const [symbol, queue] of lots) {
    if (queue.length === 0) continue;
    open.push({
      symbol,
      qty: queue.reduce((n, l) => n + l.qty, 0),
      cost: queue.reduce((n, l) => n + l.cost, 0),
      openedSim: queue[0].order.filledSim,
    });
  }

  const journal: Journal = {
    trades,
    hitRate: {
      n: trades.length, wins, rate: trades.length === 0 ? null : wins / trades.length,
      basis: "Anteil der geschlossenen Trades mit Gewinn nach Gebühren (Simulationszeit, FIFO).",
    },
    holding: {
      n: trades.length, medianSeconds: median(holds), meanSeconds: mean(holds),
      basis: "Simulationszeit zwischen Kauf und Verkauf des Postens.",
    },
    open,
    sales,
    tooEarly,
    fewData: trades.length < MIN_TRADES,
    note: NOTE,
  };
  return { journal, contexts };
}
