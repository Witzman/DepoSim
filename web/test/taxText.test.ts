import { describe, expect, it } from "vitest";
import { DISCLAIMER, frictionText, holdText } from "../src/taxText.js";
import type { TaxReport } from "../src/types.js";

type R = NonNullable<TaxReport["report"]>;
const report = (o: Partial<R> = {}): R => ({
  years: [], total: 26375, curve: [],
  gross: { totalReturn: 0.1, volatility: 0.1, sharpe: 1, maxDrawdown: -0.1, basis: "day" },
  net: { totalReturn: 0.09, volatility: 0.1, sharpe: 0.9, maxDrawdown: -0.1, basis: "day" },
  friction: { fees: 5000, tax: 26375, before: 400000, share: 0.0784 },
  hold: { tax: 20000, difference: 6375, gain: 200000 }, ...o,
});

describe("tax texts", () => {
  it("says what the view is and is not", () => {
    expect(DISCLAIMER).toMatch(/keine Steuerberatung/);
    expect(DISCLAIMER).toMatch(/brutto/);
  });
  it("tells the friction with fees, tax and share", () => {
    expect(frictionText(report())).toMatch(/Gebühren 50,00\s€ und Steuern 263,75\s€.*7,84\s?%/);
    expect(frictionText(report({ friction: { fees: 0, tax: 0, before: 0, share: null } }))).toMatch(/Kein Ertrag/);
  });
  it("compares with holding to the end without saying which is better", () => {
    expect(holdText(report())).toMatch(/63,75\s€ weniger/);
    expect(holdText(report({ hold: { tax: 30000, difference: -3625, gain: 200000 } }))).toMatch(/36,25\s€ mehr/);
    expect(holdText(report({ hold: { tax: 0, difference: 0, gain: 0 } }))).toMatch(/kein Gewinn/);
  });
});
