import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data/marketdata.js";
import {
  type DepotState, type NewOrder, type Order,
  depotValue, fillOrder, positionValue, triggersLimit, validateOrder,
} from "../src/domain/broker.js";
import { DEFAULT_FEES, previewCost } from "../src/domain/fees.js";

const eur = (price: number) => ({ price, currency: "EUR" as const });
const usd = (price: number, eurUsd: number) => ({ price, currency: "USD" as const, eurUsd });

function depot(cash = 1_000_000, positions: Record<string, { qty: number; cost: number }> = {}, orders: Order[] = []): DepotState {
  return { cash, positions: new Map(Object.entries(positions)), orders };
}
const order = (o: Partial<Order> = {}): Order => ({
  id: 1, symbol: "SAP.DE", side: "buy", kind: "market", qty: 10, status: "open", ...o,
});
const buy10 = previewCost("buy", 10, eur(214.4), "market", undefined, DEFAULT_FEES); // total 215043

describe("fillOrder", () => {
  it("a buy pays the total, opens the position at that cost and marks the order filled", () => {
    const s = depot();
    const o = order();
    fillOrder(s, o, buy10);
    expect(s.cash).toBe(1_000_000 - 215043);
    expect(s.positions.get("SAP.DE")).toEqual({ qty: 10, cost: 215043 });
    expect(o.status).toBe("filled");
  });

  it("a second buy adds quantity and cost, so the cost is the average basis", () => {
    const s = depot(1_000_000, { "SAP.DE": { qty: 10, cost: 215043 } });
    fillOrder(s, order({ id: 2 }), buy10);
    expect(s.positions.get("SAP.DE")).toEqual({ qty: 20, cost: 430086 });
  });

  it("a partial sell pays out the total and takes the cost off pro rata, rounded to a cent", () => {
    const s = depot(0, { "SAP.DE": { qty: 10, cost: 215043 } });
    const sell4 = previewCost("sell", 4, eur(214.4), "market", undefined, DEFAULT_FEES);
    fillOrder(s, order({ side: "sell", qty: 4 }), sell4);
    expect(s.cash).toBe(sell4.total);
    expect(s.positions.get("SAP.DE")).toEqual({ qty: 6, cost: 129026 });
  });

  it("selling the whole position removes it", () => {
    const s = depot(0, { "SAP.DE": { qty: 10, cost: 215043 } });
    fillOrder(s, order({ side: "sell" }), previewCost("sell", 10, eur(214.4), "market", undefined, DEFAULT_FEES));
    expect(s.positions.has("SAP.DE")).toBe(false);
  });

  it("refuses to take cash below zero or to sell what is not held, and changes nothing", () => {
    const poor = depot(100);
    const o = order();
    expect(() => fillOrder(poor, o, buy10)).toThrow();
    expect(poor.cash).toBe(100);
    expect(poor.positions.size).toBe(0);
    expect(o.status).toBe("open");

    const small = depot(0, { "SAP.DE": { qty: 2, cost: 100 } });
    expect(() => fillOrder(small, order({ side: "sell" }), previewCost("sell", 10, eur(214.4), "market", undefined, DEFAULT_FEES))).toThrow();
    expect(small.positions.get("SAP.DE")?.qty).toBe(2);
  });
});

describe("a sell whose fees are higher than its proceeds", () => {
  // 1 share at 0.10 EUR: gross 10 cents, the minimum commission of 490 cents makes the total -480.
  const cheap = () => previewCost("sell", 1, eur(0.1), "market", undefined, DEFAULT_FEES);

  it("is the case in point: the cash in is negative", () => {
    expect(cheap().total).toBe(-480);
  });

  it("is refused by fillOrder when the cash cannot cover the difference, and nothing changes", () => {
    const s = depot(100, { "SAP.DE": { qty: 1, cost: 100 } });
    const o = order({ side: "sell", qty: 1 });
    expect(() => fillOrder(s, o, cheap())).toThrow();
    expect(s.cash).toBe(100);
    expect(s.positions.get("SAP.DE")).toEqual({ qty: 1, cost: 100 });
    expect(o.status).toBe("open");
  });

  it("goes through when the cash covers the difference, and then pays it", () => {
    const s = depot(1000, { "SAP.DE": { qty: 1, cost: 100 } });
    fillOrder(s, order({ side: "sell", qty: 1 }), cheap());
    expect(s.cash).toBe(520);
    expect(s.positions.has("SAP.DE")).toBe(false);
  });

  it("is rejected by validateOrder with the reason, and accepted when the cash covers it", () => {
    const sell = { symbol: "SAP.DE", side: "sell", kind: "market", qty: 1 } as const;
    const poor = depot(100, { "SAP.DE": { qty: 1, cost: 100 } });
    const r = validateOrder(poor, sell, eur(0.1), DEFAULT_FEES);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Gebühren/) });
    const rich = depot(1000, { "SAP.DE": { qty: 1, cost: 100 } });
    expect(validateOrder(rich, sell, eur(0.1), DEFAULT_FEES)).toEqual({ ok: true });
  });

  it("is judged at the limit price for a limit order", () => {
    const poor = depot(100, { "SAP.DE": { qty: 1, cost: 100 } });
    const r = validateOrder(poor, { symbol: "SAP.DE", side: "sell", kind: "limit", qty: 1, limitPrice: 0.1 }, eur(500), DEFAULT_FEES);
    expect(r.ok).toBe(false);
  });
});

describe("validateOrder", () => {
  const market = (o: Partial<NewOrder> = {}): NewOrder => ({ symbol: "SAP.DE", side: "buy", kind: "market", qty: 1, ...o });
  const ok = (s: DepotState, o: NewOrder, ref = eur(214.4)) => validateOrder(s, o, ref, DEFAULT_FEES);

  it("accepts a plain buy and a plain sell of held shares", () => {
    expect(ok(depot(), market())).toEqual({ ok: true });
    expect(ok(depot(0, { "SAP.DE": { qty: 5, cost: 1 } }), market({ side: "sell", qty: 5 }))).toEqual({ ok: true });
  });

  it.each([0, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects the quantity %s", (qty) => {
    const r = ok(depot(), market({ qty }));
    expect(r.ok).toBe(false);
  });

  it("rejects a limit order without a positive limit price", () => {
    expect(ok(depot(), market({ kind: "limit" })).ok).toBe(false);
    expect(ok(depot(), market({ kind: "limit", limitPrice: 0 })).ok).toBe(false);
    expect(ok(depot(), market({ kind: "limit", limitPrice: -5 })).ok).toBe(false);
    expect(ok(depot(), market({ kind: "limit", limitPrice: 200 }))).toEqual({ ok: true });
  });

  it("rejects a buy above the cash, for market and for limit, and says why", () => {
    const poor = depot(100_000); // 1,000 EUR, 10 shares cost 2,150.43 EUR
    const m = ok(poor, market({ qty: 10 }));
    expect(m).toMatchObject({ ok: false });
    expect(m.ok === false && m.reason).toMatch(/Guthaben/);
    expect(ok(poor, market({ qty: 10, kind: "limit", limitPrice: 214.4 })).ok).toBe(false);
  });

  it("lets a market buy wait for a price when there is none yet", () => {
    expect(validateOrder(depot(100), market({ qty: 10 }), undefined, DEFAULT_FEES)).toEqual({ ok: true });
  });

  it("rejects selling more than is held, counting shares already in open sell orders", () => {
    const held = depot(0, { "SAP.DE": { qty: 10, cost: 1 } }, [order({ id: 7, side: "sell", qty: 5 })]);
    expect(ok(held, market({ side: "sell", qty: 6 })).ok).toBe(false);
    expect(ok(held, market({ side: "sell", qty: 5 }))).toEqual({ ok: true });
    expect(ok(depot(), market({ side: "sell", qty: 1 })).ok).toBe(false);
  });

  it("ignores filled and cancelled sell orders when counting what is reserved", () => {
    const held = depot(0, { "SAP.DE": { qty: 10, cost: 1 } }, [
      order({ id: 1, side: "sell", qty: 9, status: "filled" }),
      order({ id: 2, side: "sell", qty: 9, status: "cancelled" }),
    ]);
    expect(ok(held, market({ side: "sell", qty: 10 }))).toEqual({ ok: true });
  });

  it("counts open sell orders of other symbols as not reserved", () => {
    const held = depot(0, { "SAP.DE": { qty: 10, cost: 1 } }, [order({ id: 3, symbol: "SIE.DE", side: "sell", qty: 99 })]);
    expect(ok(held, market({ side: "sell", qty: 10 }))).toEqual({ ok: true });
  });
});

describe("triggersLimit", () => {
  const bar = (l: number, h: number): Bar => ({ t: 0, o: l, h, l, c: h, v: 1 });

  it("a buy limit triggers when the low reaches it, exactly on the limit too", () => {
    const o = order({ kind: "limit", limitPrice: 100 });
    expect(triggersLimit(o, bar(100, 105))).toBe(true);
    expect(triggersLimit(o, bar(99, 105))).toBe(true);
    expect(triggersLimit(o, bar(100.01, 105))).toBe(false);
  });

  it("a sell limit triggers when the high reaches it, exactly on the limit too", () => {
    const o = order({ kind: "limit", side: "sell", limitPrice: 100 });
    expect(triggersLimit(o, bar(95, 100))).toBe(true);
    expect(triggersLimit(o, bar(95, 101))).toBe(true);
    expect(triggersLimit(o, bar(95, 99.99))).toBe(false);
  });

  it("a market order never triggers on a bar", () => {
    expect(triggersLimit(order({ kind: "market" }), bar(1, 1000))).toBe(false);
  });
});

describe("depotValue", () => {
  it("is cash plus positions at the last price, USD at the plain rate without markup or spread", () => {
    const s = depot(10_000, { "SAP.DE": { qty: 10, cost: 215043 }, AAPL: { qty: 5, cost: 157989 } });
    const prices = new Map([["SAP.DE", eur(214.4)], ["AAPL", usd(347.725, 1.1206)]]);
    expect(depotValue(s, prices)).toBe(10_000 + 214400 + 155151);
  });

  it("values a position with no price yet at its cost, rather than at zero", () => {
    const s = depot(0, { "SAP.DE": { qty: 10, cost: 215043 } });
    expect(depotValue(s, new Map())).toBe(215043);
  });

  it("is just the cash with no positions", () => {
    expect(depotValue(depot(1234), new Map())).toBe(1234);
  });
});

describe("positionValue", () => {
  it("is quantity times price in EUR, USD at the plain rate, and the cost when there is no price", () => {
    expect(positionValue({ qty: 10, cost: 215043 }, eur(214.4))).toBe(214400);
    expect(positionValue({ qty: 5, cost: 157989 }, usd(347.725, 1.1206))).toBe(155151);
    expect(positionValue({ qty: 10, cost: 215043 }, undefined)).toBe(215043);
  });
});
