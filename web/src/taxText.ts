import type { FundType, TaxReport } from "./types.js";
import { formatEur, formatPercentPlain } from "./format.js";

export const FUND_LABEL: Record<FundType, string> = {
  equityFund: "Aktienfonds (30 % frei)", mixedFund: "Mischfonds (15 % frei)", other: "sonstiger Fonds (0 % frei)",
};

export const DISCLAIMER =
  "Das ist eine Schätzung zum Lernen und keine Steuerberatung. Der Broker bucht weiter brutto; es zählen nur realisierte Ergebnisse und Ausschüttungen, " +
  "mit den vereinfachten Regeln der Abgeltungsteuer.";

/** The friction of fees and tax in words. */
export function frictionText(r: NonNullable<TaxReport["report"]>): string {
  const f = r.friction;
  if (f.share === null) return "Kein Ertrag vor Gebühren und Steuern, an dem sich die Reibung messen ließe.";
  return `Gebühren ${formatEur(f.fees)} und Steuern ${formatEur(f.tax)} kosteten zusammen ${formatPercentPlain(f.share)} des Ertrags vor Gebühren und Steuern (${formatEur(f.before)}).`;
}

/** What selling in between cost against holding to the end, in words. Neutral about which is better. */
export function holdText(r: NonNullable<TaxReport["report"]>): string {
  const h = r.hold;
  if (h.gain <= 0) return "Bisher kein Gewinn: im Vergleich mit Halten gibt es keine Steuer, die sich aufschieben ließe.";
  const d = h.difference;
  if (d === 0) return `Wäre der Gewinn von ${formatEur(h.gain)} bis zum Ende gehalten und einmal verkauft worden, fiele dieselbe Steuer an (${formatEur(h.tax)}).`;
  return `Wäre der Gewinn von ${formatEur(h.gain)} bis zum Ende gehalten und einmal verkauft worden, fielen ${formatEur(h.tax)} Steuer an: ${formatEur(Math.abs(d))} ${d > 0 ? "weniger" : "mehr"} als jetzt geschuldet. Zinsen auf aufgeschobene Steuer sind nicht gerechnet.`;
}
