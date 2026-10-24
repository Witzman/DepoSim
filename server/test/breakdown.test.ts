import { describe, expect, it } from "vitest";
import type { Instrument } from "../src/config.js";
import { breakdown, feeLedger } from "../src/domain/breakdown.js";
import type { OrderRecord } from "../src/store.js";

const inst = (symbol: string, over: Partial<Instrument> = {}): Instrument => ({
  symbol, name: symbol, currency: "EUR", venue: "XETRA", kind: "EQUITY", sector: "Technology", ...over,
});
const list = [
  inst("SAP.DE"),
  inst("AAPL", { currency: "USD", venue: "US" }),
  inst("EUNL.DE", { kind: "ETF", sector: undefined }),
  inst("MYSTERY", { currency: "USD", venue: "US", sector: undefined }),
];
const positions = [
  { symbol: "SAP.DE", value: 3000 }, { symbol: "AAPL", value: 2000 }, { symbol: "EUNL.DE", value: 4000 }, { symbol: "MYSTERY", value: 1000 },
];

describe("breakdown", () => {
  const b = breakdown(positions, 10_000, list);
  const labels = (slices: { label: string }[]) => slices.map((s) => s.label);
  const value = (slices: { label: string; value: number }[], label: string) => slices.find((s) => s.label === label)?.value;

  it("splits by sector, with funds, unknowns and the cash apart, largest first", () => {
    expect(labels(b.sector)).toEqual(["Guthaben", "Technology", "ETF/Fonds", "Unbekannt"]);
    expect(value(b.sector, "Technology")).toBe(5000);
    expect(value(b.sector, "ETF/Fonds")).toBe(4000);
    expect(value(b.sector, "Unbekannt")).toBe(1000);
  });

  it("splits by the country of the market the title trades on", () => {
    expect(value(b.country, "Deutschland")).toBe(7000);
    expect(value(b.country, "USA")).toBe(3000);
    expect(value(b.country, "Guthaben")).toBe(10_000);
  });

  it("splits by currency, the cash counting as euro", () => {
    expect(value(b.currency, "EUR")).toBe(17_000);
    expect(value(b.currency, "USD")).toBe(3000);
  });

  it("gives shares that add up to one, in every dimension", () => {
    for (const slices of [b.sector, b.country, b.currency]) {
      expect(slices.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 9);
      expect(slices.reduce((s, x) => s + x.value, 0)).toBe(20_000);
    }
  });

  it("shows only the cash for an empty depot, and nothing for no money at all", () => {
    expect(breakdown([], 5000, list).sector).toEqual([{ label: "Guthaben", value: 5000, share: 1 }]);
    expect(breakdown([], 0, list).sector).toEqual([]);
  });

  it("counts a held symbol that is no longer in the list as unknown, and skips empty positions", () => {
    const x = breakdown([{ symbol: "GONE", value: 700 }, { symbol: "SAP.DE", value: 0 }], 0, list);
    expect(x.sector).toEqual([{ label: "Unbekannt", value: 700, share: 1 }]);
    expect(x.country).toEqual([{ label: "Unbekannt", value: 700, share: 1 }]);
    expect(x.currency).toEqual([{ label: "Unbekannt", value: 700, share: 1 }]);
  });
});

describe("feeLedger", () => {
  const order = (over: Partial<OrderRecord>): OrderRecord => ({
    id: 1, symbol: "A", side: "buy", kind: "market", qty: 1, status: "filled", createdSim: 0, commission: 490, foreignFee: 0, ...over,
  });

  it("adds commission and foreign fee of filled orders only", () => {
    const ledger = feeLedger(
      [
        order({ commission: 490 }),
        order({ id: 2, commission: 600, foreignFee: 1490 }),
        order({ id: 3, status: "open", commission: undefined }),
        order({ id: 4, status: "cancelled", commission: undefined }),
        order({ id: 5, status: "rejected", commission: undefined }),
      ],
      1_000_000,
    );
    expect(ledger).toEqual({ orders: 2, commission: 1090, foreign: 1490, total: 2580, shareOfStart: 2580 / 1_000_000 });
  });

  it("is all zero without orders", () => {
    expect(feeLedger([], 1_000_000)).toEqual({ orders: 0, commission: 0, foreign: 0, total: 0, shareOfStart: 0 });
  });
});
