import type { Excursion } from "./types.js";
import { formatEur, formatPercentPlain, signedEur } from "./format.js";

const pct = (x: number) => formatPercentPlain(x / 100);

/** The exit in words. Neutral: it says what the numbers are, not what to do. */
export function efficiencyText(e: Excursion): string {
  if (e.bars === 0 || e.mfePct === null) return "Für diese Zeit liegen keine Kurse vor: die Nachbetrachtung ist nicht berechenbar.";
  if (e.efficiency === null) return "Der Kurs lag nie über deinem Einstand: es gab keinen Gewinn mitzunehmen.";
  if (e.efficiency < 0) return `Der Kurs stand zwischendurch ${pct(e.mfePct)} über dem Einstand, der Ausstieg lag darunter.`;
  return `Du hast ${formatPercentPlain(e.efficiency)} des möglichen Gewinns mitgenommen (der Kurs stand zwischendurch ${pct(e.mfePct)} höher).`;
}

export function entryText(e: Excursion): string {
  if (e.entryPosition === null) return "Einstiegsqualität: nicht berechenbar (der Tag ist noch nicht vorbei oder ohne Spanne).";
  const where = e.entryPosition <= 0.2 ? "nahe am Tagestief" : e.entryPosition >= 0.8 ? "nahe am Tageshoch" : "in der Mitte der Tagesspanne";
  return `Einstieg ${where} (${formatPercentPlain(e.entryPosition)} der Tagesspanne, 0 % wäre das Tagestief).`;
}

export function benchmarkText(e: Excursion): string {
  if (!e.benchmark) return "Gegenprobe mit dem Maßstab: nicht berechenbar (kein Maßstab gewählt oder kein Kurs).";
  const d = e.benchmark.diff;
  return `Dasselbe Geld im Maßstab ${e.benchmark.symbol} hätte ${signedEur(e.benchmark.pnl)} gebracht; der Trade lag ${d >= 0 ? `${formatEur(d)} darüber` : `${formatEur(-d)} darunter`} (vor Gebühren).`;
}
