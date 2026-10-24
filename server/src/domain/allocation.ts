import { type FeeConfig, type Ref, previewCost } from "./fees.js";
import type { Cent } from "./money.js";

export interface AllocationInput {
  symbol: string;
  percent: number;
  ref: Ref | undefined;
}

export interface AllocationLine {
  symbol: string;
  percent: number;
  qty: number;
  /** Cash out for the market buy, fees included. 0 when nothing is bought. */
  total: Cent;
  skipped?: string;
}

const buyTotal = (qty: number, ref: Ref, fees: FeeConfig) => previewCost("buy", qty, ref, "market", undefined, fees).total;

/**
 * Turns shares in percent into whole pieces: each title gets `percent` of the cash and buys the
 * most pieces whose total, with every fee, still fits. The shares are taken from the cash before
 * anything is bought, so the totals together never exceed it.
 */
export function planAllocation(cash: Cent, inputs: AllocationInput[], fees: FeeConfig): AllocationLine[] {
  if (inputs.some((i) => !(i.percent > 0))) throw new RangeError("Jeder Anteil muss größer als 0 sein.");
  if (inputs.reduce((sum, i) => sum + i.percent, 0) > 100 + 1e-9) throw new RangeError("Die Anteile ergeben mehr als 100 %.");

  return inputs.map(({ symbol, percent, ref }): AllocationLine => {
    if (!ref) return { symbol, percent, qty: 0, total: 0, skipped: "Kein Kurs" };
    const budget = Math.floor((cash * percent) / 100);
    // The total grows with the quantity, so the largest quantity that fits can be searched for.
    // The gross of one piece bounds it from above: fees only add to it.
    let lo = 0;
    let hi = Math.floor(budget / Math.max(previewCost("buy", 1, ref, "market", undefined, fees).gross, 1));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (buyTotal(mid, ref, fees) <= budget) lo = mid;
      else hi = mid - 1;
    }
    if (lo === 0) return { symbol, percent, qty: 0, total: 0, skipped: "Budget reicht nicht für ein Stück" };
    return { symbol, percent, qty: lo, total: buyTotal(lo, ref, fees) };
  });
}
