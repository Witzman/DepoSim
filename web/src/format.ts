const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const percent = new Intl.NumberFormat("de-DE", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const byCurrency = new Map<string, Intl.NumberFormat>();

/** Euro cents as "2.150,43 €". */
export const formatEur = (cents: number) => eur.format(cents / 100);

/** A price in the currency the instrument is quoted in. */
export function formatPrice(price: number, currency: "EUR" | "USD"): string {
  let f = byCurrency.get(currency);
  if (!f) byCurrency.set(currency, (f = new Intl.NumberFormat("de-DE", { style: "currency", currency })));
  return f.format(price);
}

// A gain gets a plus sign, so gain and loss differ by more than their colour.
export const signedEur = (cents: number) => (cents > 0 ? "+" : "") + formatEur(cents);
export const signedPercent = (ratio: number) => (ratio > 0 ? "+" : "") + percent.format(ratio);

const NONE = "—";
const noNegativeZero = (s: string) => (/^-0[,.]0+(\s|$)/.test(s) ? s.slice(1) : s);

/** A ratio with two decimals, "—" when there is none. */
export const formatRatio = (x: number | null) =>
  x === null ? NONE : noNegativeZero(x.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** A ratio as percent without a plus sign (0.1234 is "12,34 %"), "—" when there is none. */
export const formatPercentPlain = (x: number | null) => (x === null ? NONE : noNegativeZero(percent.format(x)));

const BASIS = { day: "Tageswerte", hour: "Stundenwerte", "5min": "5-Minuten-Werte" } as const;
/** The step a figure is computed from, in words. */
export const basisLabel = (basis: keyof typeof BASIS | null) => (basis === null ? NONE : BASIS[basis]);
