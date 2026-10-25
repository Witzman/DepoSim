import type { Cent } from "./money.js";

/** One distribution the source knows, in the currency the instrument is quoted in. */
export interface KnownDividend {
  exDay: string;
  amount: number;
}

export interface CalendarInput {
  symbol: string;
  name: string;
  /** Pieces held now; 0 for a title the depot held before. */
  qty: number;
  /** What the pieces cost, in cents including fees. */
  cost: Cent;
  /** The price now in euro, or null while there is none. */
  priceEur: number | null;
  /** Units of the quote currency per euro (1 for euro). */
  rate: number;
  currency: "EUR" | "USD";
  /** False when the source was never asked or sent nothing for this title: the calendar says so instead of showing zero. */
  known: boolean;
  /** Every distribution up to today, oldest first. */
  dividends: KnownDividend[];
  /** What this depot was credited, by ex-day. */
  credited: { exDay: string; amount: Cent }[];
}

export interface CalendarLine {
  symbol: string;
  name: string;
  qty: number;
  known: boolean;
  /** The newest distributions, newest first, each with what the depot received for it. */
  past: { exDay: string; perShare: number; currency: "EUR" | "USD"; credited: Cent | null; source: "Yahoo" }[];
  /** Distributions of the last twelve months per piece, in euro; null without data. */
  last12mPerShare: number | null;
  /** Over the price now; null without a price or without distributions. */
  yield12m: number | null;
  /** Over what a piece cost the depot; null for a title that is not held. */
  yieldOnCost: number | null;
  /** What the last twelve months would bring on the pieces held now, in cent. */
  expectedYear: Cent | null;
  /** The months (1 to 12) the title paid in over the last two years, when it paid at least twice. */
  months: number[];
  /** A guess from the pattern, worded as one: never a promise. */
  pattern: string | null;
}

export interface Income {
  total: Cent;
  count: number;
  byYear: { year: string; amount: Cent }[];
  byMonth: { month: string; amount: Cent }[];
}

export interface Calendar {
  today: string;
  lines: CalendarLine[];
  income: Income;
  /** Distributions as a share of the start capital, and what is left of the total return when they are taken out. */
  returnSplit: { fromDistributions: number; fromPrice: number | null; total: number | null };
  note: string;
}

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const NOTE = "Beobachtung aus den Zahlungen bis heute, keine Prognose. Die Quelle (Yahoo) kennt nur vergangene Ausschüttungen.";

const minusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** The calendar of one depot at one day. Pure: the same input gives the same lines. */
export function buildCalendar(
  input: { today: string; startCash: Cent; totalReturn: number | null; titles: CalendarInput[]; bookings: { exDay: string; amount: Cent; paidDay: string }[] },
): Calendar {
  const from12 = minusDays(input.today, 365);
  const from24 = minusDays(input.today, 730);
  const lines: CalendarLine[] = input.titles.map((t) => {
    const creditedBy = new Map(t.credited.map((c) => [c.exDay, c.amount]));
    const known = t.known && t.dividends.length > 0;
    const past = (known ? [...t.dividends] : []).reverse().slice(0, 8).map((d) => ({
      exDay: d.exDay, perShare: d.amount, currency: t.currency, credited: creditedBy.get(d.exDay) ?? null, source: "Yahoo" as const,
    }));
    const last12 = t.dividends.filter((d) => d.exDay > from12 && d.exDay <= input.today).reduce((a, d) => a + d.amount, 0) / t.rate;
    const perShare = known ? last12 : null;
    const monthsSet = new Set(t.dividends.filter((d) => d.exDay > from24).map((d) => Number(d.exDay.slice(5, 7))));
    const months = [...monthsSet].sort((a, b) => a - b);
    const paidTwice = known && t.dividends.filter((d) => d.exDay > from24).length >= 2;
    const costPerShare = t.qty > 0 ? t.cost / 100 / t.qty : null;
    return {
      symbol: t.symbol, name: t.name, qty: t.qty, known, past,
      last12mPerShare: perShare,
      yield12m: perShare !== null && t.priceEur !== null && t.priceEur > 0 ? perShare / t.priceEur : null,
      yieldOnCost: perShare !== null && costPerShare !== null && costPerShare > 0 ? perShare / costPerShare : null,
      expectedYear: perShare !== null && t.qty > 0 ? Math.round(perShare * t.qty * 100) : null,
      months: paidTwice ? months : [],
      pattern: paidTwice ? `Zahlt in der Regel im ${months.map((m) => MONTHS[m - 1]).join(", ")}.` : null,
    };
  });

  const byYear = new Map<string, Cent>();
  const byMonth = new Map<string, Cent>();
  let total = 0;
  for (const b of input.bookings) {
    total += b.amount;
    byYear.set(b.paidDay.slice(0, 4), (byYear.get(b.paidDay.slice(0, 4)) ?? 0) + b.amount);
    byMonth.set(b.paidDay.slice(0, 7), (byMonth.get(b.paidDay.slice(0, 7)) ?? 0) + b.amount);
  }
  const sorted = <T extends string>(m: Map<T, Cent>) => [...m].sort(([a], [b]) => a.localeCompare(b));
  const fromDistributions = input.startCash > 0 ? total / input.startCash : 0;
  return {
    today: input.today,
    lines,
    income: {
      total, count: input.bookings.length,
      byYear: sorted(byYear).map(([year, amount]) => ({ year, amount })),
      byMonth: sorted(byMonth).map(([month, amount]) => ({ month, amount })),
    },
    returnSplit: {
      fromDistributions,
      fromPrice: input.totalReturn === null ? null : input.totalReturn - fromDistributions,
      total: input.totalReturn,
    },
    note: NOTE,
  };
}
