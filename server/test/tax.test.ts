import { describe, expect, it } from "vitest";
import { type TaxEvent, DEFAULT_TAX, holdTax, parseTaxSettings, taxAt, taxTimeline } from "../src/domain/tax.js";
import { allowanceFor, effectiveRate } from "../src/domain/taxrules.js";

const t = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;
const ev = (iso: string, pot: "stock" | "other", euro: number, exempt = 0): TaxEvent => ({ t: t(iso), pot, amount: Math.round(euro * 100), exempt });
const cfg = { ...DEFAULT_TAX, allowance: 1000 };

describe("rates", () => {
  it("25 % plus Soli is 26,375 %", () => {
    expect(effectiveRate(0)).toBeCloseTo(0.26375, 10);
  });
  it("with Kirchensteuer the base tax shrinks: 27,82 % at 8 % and 27,995 % at 9 %", () => {
    expect(effectiveRate(0.08)).toBeCloseTo(0.278186, 5);
    expect(effectiveRate(0.09)).toBeCloseTo(0.27995, 5);
  });
  it("the allowance is 801 euro before 2023 and 1.000 from then on", () => {
    expect(allowanceFor(2020)).toBe(801);
    expect(allowanceFor(2022)).toBe(801);
    expect(allowanceFor(2023)).toBe(1000);
    expect(allowanceFor(2026)).toBe(1000);
  });
});

describe("taxTimeline", () => {
  it("1.000 euro of gain is inside the allowance: no tax", () => {
    expect(taxTimeline([ev("2025-03-01", "stock", 1000)], cfg).total).toBe(0);
  });

  it("2.000 euro of gain: 1.000 x 26,375 % = 263,75 euro", () => {
    const r = taxTimeline([ev("2025-03-01", "stock", 2000)], cfg);
    expect(r.total).toBe(26375);
    expect(r.years[0]).toMatchObject({ year: 2025, base: 200000, allowance: 100000, taxable: 100000, tax: 26375 });
  });

  it("a loss on a share cannot be set against a fund gain", () => {
    const r = taxTimeline([ev("2025-03-01", "stock", -500), ev("2025-04-01", "other", 2000)], { ...cfg, allowance: 0 });
    expect(r.total).toBe(Math.round(2000 * 0.26375 * 100));
    expect(r.years[0].carryOutStock).toBe(-50000);
  });

  it("a loss of the general pot can be set against a share gain", () => {
    const r = taxTimeline([ev("2025-03-01", "stock", 2000), ev("2025-04-01", "other", -500)], { ...cfg, allowance: 0 });
    expect(r.total).toBe(Math.round(1500 * 0.26375 * 100));
    expect(r.years[0].offset).toBe(50000);
  });

  it("a share loss meets a share gain", () => {
    const r = taxTimeline([ev("2025-03-01", "stock", 2000), ev("2025-04-01", "stock", -500)], { ...cfg, allowance: 0 });
    expect(r.total).toBe(Math.round(1500 * 0.26375 * 100));
  });

  it("carries a loss over the turn of the year, and the allowance is per calendar year", () => {
    const r = taxTimeline([ev("2024-06-01", "stock", -3000), ev("2025-06-01", "stock", 5000)], cfg);
    expect(r.years[0]).toMatchObject({ year: 2024, tax: 0, carryOutStock: -300000 });
    // 5.000 - 3.000 carried = 2.000, less 1.000 allowance = 1.000 taxable
    expect(r.years[1]).toMatchObject({ year: 2025, carryInStock: -300000, taxable: 100000, tax: 26375 });
    expect(r.total).toBe(26375);
  });

  it("the allowance of a year does not carry over: two years of 1.000 gain are both free", () => {
    expect(taxTimeline([ev("2024-06-01", "stock", 1000), ev("2025-06-01", "stock", 1000)], cfg).total).toBe(0);
  });

  it("the Teilfreistellung of 30 % on an equity fund: 2.000 becomes 1.400, minus 1.000 allowance, 400 x 26,375 %", () => {
    const r = taxTimeline([ev("2025-03-01", "other", 2000, 0.3)], cfg);
    expect(r.total).toBe(10550);
  });

  it("a year decides by the simulation time: 2020 has the allowance of 801", () => {
    const r = taxTimeline([ev("2020-03-01", "stock", 1801)], { ...cfg, allowance: null });
    expect(r.years[0].allowance).toBe(80100);
    expect(r.total).toBe(26375);
  });

  it("steps follow the running total and fall when a later loss is set off", () => {
    const r = taxTimeline([ev("2025-03-01", "stock", 3000), ev("2025-09-01", "stock", -1500)], cfg);
    expect(r.steps.map((s) => s.cumTax)).toEqual([52750, 13188]); // 2.000 taxable, then 500 taxable
    expect(taxAt(r, t("2025-02-01"))).toBe(0);
    expect(taxAt(r, t("2025-05-01"))).toBe(52750);
    expect(taxAt(r, t("2026-01-01"))).toBe(13188);
  });

  it("church tax raises the tax", () => {
    const plain = taxTimeline([ev("2025-03-01", "stock", 2000)], cfg).total;
    const church = taxTimeline([ev("2025-03-01", "stock", 2000)], { ...cfg, church: 0.09 }).total;
    expect(church).toBe(27995);
    expect(church).toBeGreaterThan(plain);
  });

  it("no events, no tax", () => {
    expect(taxTimeline([], cfg)).toEqual({ years: [], steps: [], total: 0 });
  });
});

describe("holdTax", () => {
  it("taxes a gain once after one allowance and nothing for a loss", () => {
    expect(holdTax(200000, 2025, cfg)).toBe(26375);
    expect(holdTax(-5000, 2025, cfg)).toBe(0);
  });
});

describe("parseTaxSettings", () => {
  it("falls back to off for anything odd and keeps valid fields", () => {
    expect(parseTaxSettings(null)).toEqual(DEFAULT_TAX);
    expect(parseTaxSettings("{nope")).toEqual(DEFAULT_TAX);
    expect(parseTaxSettings(JSON.stringify({ enabled: true, church: 0.09, allowance: 500, fundTypes: { EUNL: "mixedFund", X: "bad" } })))
      .toEqual({ enabled: true, church: 0.09, allowance: 500, fundTypes: { EUNL: "mixedFund" } });
    expect(parseTaxSettings({ church: 0.5, allowance: -3 })).toEqual(DEFAULT_TAX);
  });
});
