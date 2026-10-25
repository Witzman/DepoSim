import type { DepotState } from "./broker.js";
import { type Cent, roundCent } from "./money.js";

/**
 * What a distribution pays: shares x amount per share, converted at the rate of the ex-day
 * (units of the instrument's currency per EUR; 1 for EUR). The long-term comparison uses this too,
 * so both give the same number for the same shares.
 */
export const dividendCredit = (qty: number, amountPerShare: number, rate = 1): Cent => roundCent((qty * amountPerShare * 100) / rate);

/** The price ratio a split numerator:denominator causes (4:1 gives 0.25). */
export const splitPriceRatio = (numerator: number, denominator: number) => denominator / numerator;

/**
 * True if the bars show the split: the first price after it is near the last one before it times the
 * ratio. Yahoo adjusts history that it serves after a split, so bars loaded later show no jump and
 * the depot must not be changed for them; bars loaded before the split show it.
 */
export function showsSplit(closeBefore: number, openAfter: number, numerator: number, denominator: number): boolean {
  if (!(closeBefore > 0) || !(openAfter > 0)) return false;
  const expected = closeBefore * splitPriceRatio(numerator, denominator);
  return Math.abs(openAfter / expected - 1) < 0.3;
}

export interface SplitResult {
  qty: number;
  /** Paid out for a fraction of a share, in cent. */
  cashOut: Cent;
}

/**
 * A split numerator:denominator (4:1 gives four shares for one). The cost basis stays what it was; a
 * fraction of a share is paid out at `price` (EUR per new share) and takes its part of the cost with it.
 */
export function applySplit(state: DepotState, symbol: string, numerator: number, denominator: number, priceEur: number | undefined): SplitResult | undefined {
  const pos = state.positions.get(symbol);
  if (!pos || !(numerator > 0) || !(denominator > 0)) return undefined;
  const exact = (pos.qty * numerator) / denominator;
  const qty = Math.floor(exact + 1e-9);
  const fraction = exact - qty;
  const cashOut = fraction > 1e-9 && priceEur !== undefined ? roundCent(fraction * priceEur * 100) : 0;
  const keep = qty === 0 ? 0 : roundCent((pos.cost * qty) / exact);
  state.cash += cashOut;
  if (qty === 0) state.positions.delete(symbol);
  else state.positions.set(symbol, { qty, cost: keep });
  return { qty, cashOut };
}

/** The quantity and limit of an open order after a split. */
export function splitOrder(qty: number, limitPrice: number | undefined, numerator: number, denominator: number) {
  return {
    qty: Math.max(1, Math.floor((qty * numerator) / denominator + 1e-9)),
    limitPrice: limitPrice === undefined ? undefined : (limitPrice * denominator) / numerator,
  };
}
