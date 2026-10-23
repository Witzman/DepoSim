import { type Cent, roundCent } from "./money.js";

export interface FeeConfig {
  commissionPct: number;
  commissionMin: Cent;
  commissionMax: Cent;
  foreignFlat: Cent;
  fxMarkupPct: number;
  spreadPct: number;
}

/** Placeholders except the foreign flat fee, which follows an undated ING page. */
export const DEFAULT_FEES: FeeConfig = {
  commissionPct: 0.0025,
  commissionMin: 490,
  commissionMax: 5990,
  foreignFlat: 1490,
  fxMarkupPct: 0.005,
  spreadPct: 0.0005,
};

export type Side = "buy" | "sell";

/** `eurUsd` is USD per EUR and required for a USD instrument. */
export interface Ref {
  price: number;
  currency: "EUR" | "USD";
  eurUsd?: number;
}

/** `total` is the cash out for a buy and the cash in for a sell. */
export interface CostPreview {
  execPrice: number;
  fxRateEff?: number;
  gross: Cent;
  commission: Cent;
  foreign: Cent;
  total: Cent;
}

export function previewCost(
  side: Side,
  qty: number,
  ref: Ref,
  kind: "market" | "limit",
  limitPrice: number | undefined,
  fees: FeeConfig,
): CostPreview {
  const buy = side === "buy";

  // The order of these operations is fixed: in floating point it changes the last cent.
  let execPrice: number;
  if (kind === "limit") {
    if (limitPrice === undefined) throw new Error("a limit order needs a limit price");
    execPrice = limitPrice;
  } else {
    execPrice = ref.price * (buy ? 1 + fees.spreadPct : 1 - fees.spreadPct);
  }

  let gross: Cent;
  let fxRateEff: number | undefined;
  if (ref.currency === "USD") {
    if (ref.eurUsd === undefined) throw new Error("a USD instrument needs the EUR/USD rate");
    fxRateEff = ref.eurUsd * (buy ? 1 - fees.fxMarkupPct : 1 + fees.fxMarkupPct);
    gross = roundCent((qty * execPrice) / fxRateEff * 100);
  } else {
    gross = roundCent(qty * execPrice * 100);
  }

  const commission = Math.min(
    fees.commissionMax,
    Math.max(fees.commissionMin, roundCent(gross * fees.commissionPct)),
  );
  const foreign = ref.currency === "USD" ? fees.foreignFlat : 0;
  const total = buy ? gross + commission + foreign : gross - commission - foreign;

  return { execPrice, fxRateEff, gross, commission, foreign, total };
}
