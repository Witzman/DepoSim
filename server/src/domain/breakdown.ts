import type { Instrument } from "../config.js";
import type { Cent } from "./money.js";
import type { OrderRecord } from "../store.js";

export interface Slice {
  label: string;
  value: Cent;
  /** Of the depot's whole value, cash included. */
  share: number;
}

export interface Breakdown {
  sector: Slice[];
  /** The country of the market a title trades on, not where the company is based. */
  country: Slice[];
  currency: Slice[];
}

const COUNTRY = { XETRA: "Deutschland", US: "USA" } as const;
const CASH = "Guthaben";
const UNKNOWN = "Unbekannt";

function slices(parts: [string, Cent][]): Slice[] {
  const sums = new Map<string, Cent>();
  for (const [label, value] of parts) if (value !== 0) sums.set(label, (sums.get(label) ?? 0) + value);
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  return [...sums]
    .map(([label, value]) => ({ label, value, share: total === 0 ? 0 : value / total }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Where the money of a depot sits: positions by their value now, and the cash on top. */
export function breakdown(positions: { symbol: string; value: Cent }[], cash: Cent, instruments: Instrument[]): Breakdown {
  const known = new Map(instruments.map((i) => [i.symbol, i]));
  const sector: [string, Cent][] = [[CASH, cash]];
  const country: [string, Cent][] = [[CASH, cash]];
  const currency: [string, Cent][] = [["EUR", cash]]; // the account is in euro
  for (const p of positions) {
    const i = known.get(p.symbol);
    sector.push([i ? (i.kind === "ETF" ? "ETF/Fonds" : i.sector ?? UNKNOWN) : UNKNOWN, p.value]);
    country.push([i ? COUNTRY[i.venue] : UNKNOWN, p.value]);
    currency.push([i ? i.currency : UNKNOWN, p.value]);
  }
  return { sector: slices(sector), country: slices(country), currency: slices(currency) };
}

export interface FeeLedger {
  orders: number;
  commission: Cent;
  foreign: Cent;
  total: Cent;
  shareOfStart: number;
}

/**
 * The fees that were booked: commission and foreign flat fee of filled orders. The spread and the
 * exchange-rate markup sit in the execution price and are not part of this.
 */
export function feeLedger(orders: OrderRecord[], startCash: Cent): FeeLedger {
  let n = 0;
  let commission = 0;
  let foreign = 0;
  for (const o of orders) {
    if (o.status !== "filled") continue;
    n++;
    commission += o.commission ?? 0;
    foreign += o.foreignFee ?? 0;
  }
  const total = commission + foreign;
  return { orders: n, commission, foreign, total, shareOfStart: startCash > 0 ? total / startCash : 0 };
}
