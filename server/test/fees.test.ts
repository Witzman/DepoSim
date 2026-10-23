import { describe, expect, it } from "vitest";
import { DEFAULT_FEES, previewCost } from "../src/domain/fees.js";
import { roundCent } from "../src/domain/money.js";

const eur = (price: number) => ({ price, currency: "EUR" as const });
const usd = (price: number, eurUsd: number) => ({ price, currency: "USD" as const, eurUsd });

describe("roundCent", () => {
  it("rounds half away from zero, symmetric around 0", () => {
    expect(roundCent(2.5)).toBe(3);
    expect(roundCent(-2.5)).toBe(-3);
    expect(roundCent(2.4)).toBe(2);
    expect(roundCent(-2.4)).toBe(-2);
  });
});

describe("previewCost, EUR instrument", () => {
  it("buy 10 at 214.40 market", () => {
    const c = previewCost("buy", 10, eur(214.4), "market", undefined, DEFAULT_FEES);
    expect(c).toMatchObject({ gross: 214507, commission: 536, foreign: 0, total: 215043 });
  });

  it("sell 10 at 214.40 market", () => {
    const c = previewCost("sell", 10, eur(214.4), "market", undefined, DEFAULT_FEES);
    expect(c).toMatchObject({ gross: 214293, commission: 536, foreign: 0, total: 213757 });
  });

  it("the minimum commission applies to a small trade", () => {
    const c = previewCost("buy", 1, eur(10), "market", undefined, DEFAULT_FEES);
    expect(c).toMatchObject({ gross: 1000, commission: 490, total: 1490 });
  });

  it("the maximum commission applies to a large trade", () => {
    const c = previewCost("buy", 1000, eur(100), "market", undefined, DEFAULT_FEES);
    expect(c).toMatchObject({ gross: 10005000, commission: 5990, total: 10010990 });
  });

  it("a limit order executes at the limit price with no spread", () => {
    const c = previewCost("buy", 10, eur(214.4), "limit", 200, DEFAULT_FEES);
    expect(c.execPrice).toBe(200);
    expect(c.gross).toBe(200000);
  });
});

describe("previewCost, USD instrument", () => {
  it("buy 5 at 347.725 USD pays the markup on the exchange rate and the foreign flat fee", () => {
    const c = previewCost("buy", 5, usd(347.725, 1.1206), "market", undefined, DEFAULT_FEES);
    expect(c.fxRateEff).toBeCloseTo(1.114997, 6);
    expect(c).toMatchObject({ gross: 156009, commission: 490, foreign: 1490, total: 157989 });
  });

  it("sell 5 at 347.725 USD receives less because the markup works against the seller too", () => {
    const c = previewCost("sell", 5, usd(347.725, 1.1206), "market", undefined, DEFAULT_FEES);
    expect(c).toMatchObject({ gross: 154302, commission: 490, foreign: 1490, total: 152322 });
  });
});

describe("previewCost, amounts are whole cents", () => {
  it("every Cent field is an integer", () => {
    const cases = [
      previewCost("buy", 7, eur(33.337), "market", undefined, DEFAULT_FEES),
      previewCost("sell", 3, usd(123.456, 1.0873), "market", undefined, DEFAULT_FEES),
      previewCost("buy", 13, usd(9.99, 1.0873), "limit", 9.5, DEFAULT_FEES),
    ];
    for (const c of cases) {
      for (const v of [c.gross, c.commission, c.foreign, c.total]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});
