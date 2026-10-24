import { describe, expect, it } from "vitest";
import { planAllocation } from "../src/domain/allocation.js";
import { DEFAULT_FEES, type Ref, previewCost } from "../src/domain/fees.js";

const eur = (price: number): Ref => ({ price, currency: "EUR" });
const usd = (price: number): Ref => ({ price, currency: "USD", eurUsd: 1.1 });
const totalOf = (qty: number, ref: Ref) => previewCost("buy", qty, ref, "market", undefined, DEFAULT_FEES).total;

describe("planAllocation", () => {
  it("buys the most pieces whose total, fees included, fits the share", () => {
    const cash = 1_000_000;
    const [a, b] = planAllocation(
      cash,
      [{ symbol: "A", percent: 60, ref: eur(100) }, { symbol: "B", percent: 40, ref: eur(50) }],
      DEFAULT_FEES,
    );
    expect(a.total).toBeLessThanOrEqual(600_000);
    expect(totalOf(a.qty + 1, eur(100))).toBeGreaterThan(600_000);
    expect(b.total).toBeLessThanOrEqual(400_000);
    expect(totalOf(b.qty + 1, eur(50))).toBeGreaterThan(400_000);
    expect(a.total + b.total).toBeLessThanOrEqual(cash);
    expect(a.total).toBe(totalOf(a.qty, eur(100)));
  });

  it("charges the foreign flat fee for a USD title", () => {
    const [line] = planAllocation(1_000_000, [{ symbol: "U", percent: 100, ref: usd(100) }], DEFAULT_FEES);
    expect(line.total).toBe(totalOf(line.qty, usd(100)));
    expect(line.total).toBeLessThanOrEqual(1_000_000);
    expect(totalOf(line.qty + 1, usd(100))).toBeGreaterThan(1_000_000);
  });

  it("skips a title whose share does not buy one piece, and says why", () => {
    const [line] = planAllocation(1_000_000, [{ symbol: "A", percent: 1, ref: eur(100) }], DEFAULT_FEES);
    expect(line).toMatchObject({ qty: 0, total: 0, skipped: "Budget reicht nicht für ein Stück" });
  });

  it("skips a title without a price", () => {
    const [line] = planAllocation(1_000_000, [{ symbol: "A", percent: 50, ref: undefined }], DEFAULT_FEES);
    expect(line).toMatchObject({ qty: 0, skipped: "Kein Kurs" });
  });

  it("rejects a percent of zero or less and a sum above 100", () => {
    expect(() => planAllocation(1000, [{ symbol: "A", percent: 0, ref: eur(1) }], DEFAULT_FEES)).toThrow(RangeError);
    expect(() => planAllocation(1000, [{ symbol: "A", percent: -5, ref: eur(1) }], DEFAULT_FEES)).toThrow(RangeError);
    expect(() =>
      planAllocation(1000, [{ symbol: "A", percent: 60, ref: eur(1) }, { symbol: "B", percent: 41, ref: eur(1) }], DEFAULT_FEES),
    ).toThrow(RangeError);
  });

  it("buys nothing from an empty depot", () => {
    const [line] = planAllocation(0, [{ symbol: "A", percent: 100, ref: eur(10) }], DEFAULT_FEES);
    expect(line.qty).toBe(0);
  });
});
