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

/** The two largest units of a span: "3 T 4 Std", "2 Std 5 Min", "45 Min". "—" when there is none. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return NONE;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} T ${hours} Std` : `${days} T`;
  if (hours > 0) return minutes > 0 ? `${hours} Std ${minutes} Min` : `${hours} Std`;
  return minutes > 0 ? `${minutes} Min` : "unter 1 Min";
}

/** A sign that is not a colour: up, down, or level. */
export const arrowOf = (n: number) => (n > 0 ? "▲" : n < 0 ? "▼" : "•");
/** Euro cents with arrow and sign: "▲ +10,00 €". */
export const signedEurArrow = (cents: number) => `${arrowOf(cents)} ${signedEur(cents)}`;

/** Reads a euro amount typed by a person ("1.500,50" or "1500.5"); null when it is empty or not a number. */
export function parseEuro(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
