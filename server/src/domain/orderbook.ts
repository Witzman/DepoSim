import type { Bar } from "../data/marketdata.js";

/** Always shown with the book: it is a picture drawn from the last candle, not market depth. */
export const LABEL = "SIMULIERT, keine echten Tiefendaten, aus der Kerze abgeleitet";

/** Share of the bar's volume (in thousands) shown at each level, nearest level first. */
const DECAY = [1, 0.8, 0.6, 0.45, 0.3];
/** The half-spread is this share of the bar's range, but at least one tick. */
const SPREAD_SHARE = 0.1;

/**
 * The smallest price step shown: 0.01 below 100, 0.05 below 1000, 0.1 from there. A display choice,
 * not the tick size of any exchange.
 */
export function tickFor(price: number): number {
  return price < 100 ? 0.01 : price < 1000 ? 0.05 : 0.1;
}

export interface BookLevel {
  price: number;
  size: number;
}

export type Orderbook =
  | {
      available: true;
      simulated: true;
      label: string;
      symbol: string;
      currency: "EUR" | "USD";
      /** The end of the candle the book is drawn from. */
      asOf: number;
      mid: number;
      tick: number;
      halfSpread: number;
      /** Nearest to the mid first. */
      asks: BookLevel[];
      bids: BookLevel[];
    }
  | { available: false; simulated: true; label: string; symbol: string; reason: string };

const clean = (x: number) => Math.round(x * 10_000) / 10_000;

/** Display only: nothing here feeds the broker, fills or fees. */
export function buildOrderbook(input: {
  symbol: string;
  currency: "EUR" | "USD";
  /** The last finished bar at the simulation time. */
  bar: Bar | undefined;
  venueOpen: boolean;
}): Orderbook {
  const { symbol, currency, bar, venueOpen } = input;
  const none = (reason: string): Orderbook => ({ available: false, simulated: true, label: LABEL, symbol, reason });
  if (!bar) return none("Für dieses Wertpapier gibt es noch keine Kerze.");
  if (!venueOpen) return none("Der Handelsplatz ist geschlossen, es gibt kein Orderbuch.");
  if (!(bar.v > 0)) return none("Die letzte Kerze hat kein Volumen, es gibt kein Orderbuch.");

  const mid = bar.c;
  const tick = tickFor(mid);
  const midTicks = Math.round(mid / tick);
  const halfTicks = Math.max(1, Math.round(((bar.h - bar.l) * SPREAD_SHARE) / tick));
  const levels = (sign: 1 | -1): BookLevel[] =>
    DECAY.map((decay, i) => ({
      price: clean((midTicks + sign * (halfTicks + i)) * tick),
      size: Math.max(1, Math.round((bar.v / 1000) * decay)),
    })).filter((l) => l.price > 0);

  return {
    available: true, simulated: true, label: LABEL, symbol, currency,
    asOf: bar.t + 60, mid, tick, halfSpread: clean(halfTicks * tick),
    asks: levels(1), bids: levels(-1),
  };
}
