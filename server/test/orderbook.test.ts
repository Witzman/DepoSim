import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data/marketdata.js";
import { LABEL, buildOrderbook, tickFor } from "../src/domain/orderbook.js";

const bar = (c: number, h: number, l: number, v: number): Bar => ({ t: 1000, o: c, h, l, c, v });
const base = { symbol: "SAP.DE", currency: "EUR" as const, venueOpen: true };

describe("tickFor", () => {
  it("steps 0.01 below 100, 0.05 below 1000 and 0.1 above", () => {
    expect([tickFor(5), tickFor(99.99), tickFor(100), tickFor(999.9), tickFor(1000), tickFor(5000)]).toEqual([0.01, 0.01, 0.05, 0.05, 0.1, 0.1]);
  });
});

describe("buildOrderbook", () => {
  it("builds 5 levels each side from the close, a tenth of the range as half-spread and the volume with a fixed decay", () => {
    const book = buildOrderbook({ ...base, bar: bar(100, 101, 99, 10_000) });
    expect(book).toMatchObject({ available: true, simulated: true, label: LABEL, symbol: "SAP.DE", currency: "EUR", mid: 100, tick: 0.05, asOf: 1060 });
    if (!book.available) throw new Error("unreachable");
    expect(book.halfSpread).toBe(0.2); // (101 - 99) * 0.1
    expect(book.asks.map((l) => l.price)).toEqual([100.2, 100.25, 100.3, 100.35, 100.4]);
    expect(book.bids.map((l) => l.price)).toEqual([99.8, 99.75, 99.7, 99.65, 99.6]);
    expect(book.asks.map((l) => l.size)).toEqual([10, 8, 6, 5, 3]);
    expect(book.bids.map((l) => l.size)).toEqual([10, 8, 6, 5, 3]);
  });

  it("holds the half-spread at one tick for a flat bar and has at least size 1", () => {
    const book = buildOrderbook({ ...base, bar: bar(50, 50, 50, 500) });
    if (!book.available) throw new Error("unreachable");
    expect(book.halfSpread).toBe(0.01);
    expect(book.asks[0].price).toBe(50.01);
    expect(book.bids[0].price).toBe(49.99);
    expect(book.asks.map((l) => l.size)).toEqual([1, 1, 1, 1, 1]);
  });

  it("is the same every time, with no randomness", () => {
    const b = bar(123.45, 124, 123, 40_000);
    expect(buildOrderbook({ ...base, bar: b })).toEqual(buildOrderbook({ ...base, bar: b }));
  });

  it("says why there is no book: no bar, closed venue, no volume", () => {
    expect(buildOrderbook({ ...base, bar: undefined })).toMatchObject({ available: false, simulated: true, reason: expect.stringMatching(/Kerze/) });
    expect(buildOrderbook({ ...base, bar: bar(100, 101, 99, 5), venueOpen: false })).toMatchObject({ available: false, reason: expect.stringMatching(/geschlossen/) });
    expect(buildOrderbook({ ...base, bar: bar(100, 101, 99, 0) })).toMatchObject({ available: false, reason: expect.stringMatching(/Volumen/) });
  });

  it("never lists a price at or below zero", () => {
    const book = buildOrderbook({ ...base, bar: bar(0.03, 0.2, 0.01, 5000) });
    if (!book.available) throw new Error("unreachable");
    expect(book.bids.every((l) => l.price > 0)).toBe(true);
  });
});
