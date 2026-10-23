import type { Bar } from "../data/marketdata.js";
import { type FeeConfig, type CostPreview, type Ref, type Side, previewCost } from "./fees.js";
import { type Cent, roundCent } from "./money.js";

export type OrderKind = "market" | "limit";
export type OrderStatus = "open" | "filled" | "cancelled" | "rejected";

export interface Order {
  id: number;
  symbol: string;
  side: Side;
  kind: OrderKind;
  qty: number;
  limitPrice?: number;
  status: OrderStatus;
}

export type NewOrder = Omit<Order, "id" | "status">;

export interface DepotState {
  cash: Cent;
  /** `cost` is what the shares cost in cents including fees, the basis for profit and loss. */
  positions: Map<string, { qty: number; cost: Cent }>;
  orders: Order[];
}

export type Validation = { ok: true } | { ok: false; reason: string };

const eur = (c: Cent) => `${(c / 100).toFixed(2).replace(".", ",")} €`;

/**
 * Cash is not reserved for open buy orders: the check happens again when one fills.
 * With no `ref` there is no price to check a market buy against, so it may wait for one.
 */
export function validateOrder(state: DepotState, o: NewOrder, ref: Ref | undefined, fees: FeeConfig): Validation {
  if (!Number.isInteger(o.qty) || o.qty <= 0) {
    return { ok: false, reason: "Die Menge muss eine positive ganze Zahl sein." };
  }
  if (o.kind === "limit" && !(Number.isFinite(o.limitPrice) && (o.limitPrice as number) > 0)) {
    return { ok: false, reason: "Ein Limit-Auftrag braucht einen Limitpreis über 0." };
  }

  if (o.side === "buy") {
    const priceable = ref !== undefined && !(ref.currency === "USD" && ref.eurUsd === undefined);
    if (priceable) {
      const total = previewCost("buy", o.qty, ref, o.kind, o.limitPrice, fees).total;
      if (total > state.cash) {
        return { ok: false, reason: `Das Guthaben reicht nicht (benötigt ${eur(total)}, verfügbar ${eur(state.cash)}).` };
      }
    }
    return { ok: true };
  }

  const held = state.positions.get(o.symbol)?.qty ?? 0;
  const reserved = state.orders
    .filter((x) => x.status === "open" && x.side === "sell" && x.symbol === o.symbol)
    .reduce((n, x) => n + x.qty, 0);
  if (o.qty + reserved > held) {
    const note = reserved > 0 ? ` (${reserved} davon in offenen Verkaufsorders)` : "";
    return { ok: false, reason: `Du hältst nur ${held} Stück ${o.symbol}${note}.` };
  }
  return { ok: true };
}

/** Books an execution. Throws, and changes nothing, if it would break the depot. */
export function fillOrder(state: DepotState, o: Order, execution: CostPreview): void {
  const pos = state.positions.get(o.symbol);
  if (o.side === "buy") {
    if (execution.total > state.cash) throw new Error("not enough cash for this fill");
    state.cash -= execution.total;
    state.positions.set(o.symbol, {
      qty: (pos?.qty ?? 0) + o.qty,
      cost: (pos?.cost ?? 0) + execution.total,
    });
  } else {
    if (!pos || pos.qty < o.qty) throw new Error("selling more than is held");
    state.cash += execution.total;
    if (pos.qty === o.qty) {
      state.positions.delete(o.symbol);
    } else {
      state.positions.set(o.symbol, {
        qty: pos.qty - o.qty,
        cost: pos.cost - roundCent((pos.cost * o.qty) / pos.qty),
      });
    }
  }
  o.status = "filled";
}

/** A buy limit fires when the bar's low reaches it, a sell limit when the high does. */
export function triggersLimit(o: Order, bar: Bar): boolean {
  if (o.kind !== "limit" || o.limitPrice === undefined) return false;
  return o.side === "buy" ? bar.l <= o.limitPrice : bar.h >= o.limitPrice;
}

/**
 * One position at its last price. USD converts at the plain rate, with no markup and no
 * spread: this is a value, not a trade. With no price yet it counts at its cost instead of
 * dropping to zero.
 */
export function positionValue(pos: { qty: number; cost: Cent }, ref: Ref | undefined): Cent {
  if (!ref) return pos.cost;
  if (ref.currency === "USD") {
    if (ref.eurUsd === undefined) throw new Error("no EUR/USD rate for a USD price");
    return roundCent((pos.qty * ref.price) / ref.eurUsd * 100);
  }
  return roundCent(pos.qty * ref.price * 100);
}

/** Cash plus every position at its last price. */
export function depotValue(state: DepotState, prices: Map<string, Ref>): Cent {
  let total = state.cash;
  for (const [symbol, pos] of state.positions) total += positionValue(pos, prices.get(symbol));
  return total;
}
