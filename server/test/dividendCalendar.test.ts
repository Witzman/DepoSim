import { describe, expect, it } from "vitest";
import { buildCalendar, type CalendarInput } from "../src/domain/dividendCalendar.js";

const title = (over: Partial<CalendarInput> = {}): CalendarInput => ({
  symbol: "ALV.DE", name: "Allianz", qty: 10, cost: 200_000, priceEur: 250, rate: 1, currency: "EUR", known: true,
  dividends: [{ exDay: "2024-05-10", amount: 13 }, { exDay: "2025-05-09", amount: 15 }, { exDay: "2026-05-08", amount: 16 }],
  credited: [{ exDay: "2026-05-08", amount: 16_000 }], ...over,
});
const base = { today: "2026-10-25", startCash: 1_000_000, totalReturn: 0.1, bookings: [] as { exDay: string; amount: number; paidDay: string }[] };

describe("buildCalendar", () => {
  it("counts the last twelve months, the yield on the price and on what the pieces cost", () => {
    const [l] = buildCalendar({ ...base, titles: [title()] }).lines;
    expect(l.known).toBe(true);
    expect(l.last12mPerShare).toBe(16);
    expect(l.yield12m).toBeCloseTo(16 / 250, 12);
    expect(l.yieldOnCost).toBeCloseTo(16 / 200, 12); // 2000 € for 10 pieces: 200 € a piece
    expect(l.expectedYear).toBe(16_000);
  });

  it("lists the newest first, with what the depot received and the source", () => {
    const [l] = buildCalendar({ ...base, titles: [title()] }).lines;
    expect(l.past.map((p) => p.exDay)).toEqual(["2026-05-08", "2025-05-09", "2024-05-10"]);
    expect(l.past[0]).toMatchObject({ credited: 16_000, source: "Yahoo", currency: "EUR" });
    expect(l.past[1].credited).toBeNull();
  });

  it("says nothing instead of zero when the source has no distributions", () => {
    for (const t of [title({ known: false }), title({ dividends: [] })]) {
      const [l] = buildCalendar({ ...base, titles: [t] }).lines;
      expect(l).toMatchObject({ known: false, last12mPerShare: null, yield12m: null, yieldOnCost: null, expectedYear: null, pattern: null, past: [] });
    }
  });

  it("words the pattern as an observation, and only after two payments in two years", () => {
    const quarterly = title({ dividends: [{ exDay: "2026-03-12", amount: 1 }, { exDay: "2026-06-11", amount: 1 }, { exDay: "2026-09-10", amount: 1 }] });
    expect(buildCalendar({ ...base, titles: [quarterly] }).lines[0].pattern).toBe("Zahlt in der Regel im März, Juni, September.");
    const once = title({ dividends: [{ exDay: "2026-05-08", amount: 1 }] });
    expect(buildCalendar({ ...base, titles: [once] }).lines[0]).toMatchObject({ pattern: null, months: [] });
  });

  it("converts a dollar amount at the rate, and has no yield without a price or a held piece", () => {
    const usd = title({ currency: "USD", rate: 1.25, priceEur: 80, dividends: [{ exDay: "2026-08-01", amount: 2.5 }] });
    const [l] = buildCalendar({ ...base, titles: [usd] }).lines;
    expect(l.last12mPerShare).toBeCloseTo(2, 12);
    expect(l.yield12m).toBeCloseTo(2 / 80, 12);
    const gone = buildCalendar({ ...base, titles: [title({ qty: 0, cost: 0, priceEur: null })] }).lines[0];
    expect(gone).toMatchObject({ yield12m: null, yieldOnCost: null, expectedYear: null });
    expect(gone.last12mPerShare).toBe(16);
  });

  it("ignores payments older than twelve months for the yield", () => {
    const old = title({ dividends: [{ exDay: "2025-10-24", amount: 9 }, { exDay: "2025-10-26", amount: 3 }] });
    expect(buildCalendar({ ...base, titles: [old] }).lines[0].last12mPerShare).toBe(3);
  });

  it("sums the income by year and month and splits the return into distributions and price", () => {
    const c = buildCalendar({
      ...base, totalReturn: 0.1,
      titles: [],
      bookings: [
        { exDay: "2025-05-09", amount: 10_000, paidDay: "2025-05-09" },
        { exDay: "2026-03-12", amount: 5_000, paidDay: "2026-03-12" },
        { exDay: "2026-05-08", amount: 20_000, paidDay: "2026-05-08" },
      ],
    });
    expect(c.income).toEqual({
      total: 35_000, count: 3,
      byYear: [{ year: "2025", amount: 10_000 }, { year: "2026", amount: 25_000 }],
      byMonth: [{ month: "2025-05", amount: 10_000 }, { month: "2026-03", amount: 5_000 }, { month: "2026-05", amount: 20_000 }],
    });
    expect(c.returnSplit.fromDistributions).toBeCloseTo(0.035, 12);
    expect(c.returnSplit.fromPrice).toBeCloseTo(0.065, 12);
  });

  it("has no price share when the return is not known, and zero income without bookings", () => {
    const c = buildCalendar({ ...base, totalReturn: null, titles: [] });
    expect(c.returnSplit).toEqual({ fromDistributions: 0, fromPrice: null, total: null });
    expect(c.income).toEqual({ total: 0, count: 0, byYear: [], byMonth: [] });
  });
});
