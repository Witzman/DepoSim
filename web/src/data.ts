import type { CallKind, CellState, DataCell, DataStatus, Light } from "./types.js";

/** The words of the light, for the top bar and for screen readers. */
export const LIGHT_WORD: Record<Light, string> = { green: "grün", yellow: "gelb", red: "rot" };

/** What the top bar says: the first reason of the worst level, or that all is well. */
export function lightLine(status: DataStatus): { text: string; title: string } {
  const bad = status.reasons.filter((r) => r.level !== "info");
  return {
    text: `Daten: ${LIGHT_WORD[status.level]}`,
    title: bad.length ? bad.map((r) => r.text).join("\n") : "Daten in Ordnung.",
  };
}

export const STATE_WORD: Record<CellState, string> = {
  complete: "vollständig",
  partial: "unvollständig",
  empty: "leer (Quelle lieferte nichts)",
  never: "nie geladen",
  closed: "Börse geschlossen",
};

const de = (n: number) => n.toLocaleString("de-DE");
export const dayShort = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.`;
export const dayLong = (day: string) => day.split("-").reverse().join(".");

/** The tooltip and the screen reader text of one cell of the grid. */
export function cellLabel(symbol: string, cell: DataCell): string {
  const parts = [`${symbol}, ${dayLong(cell.day)}: ${STATE_WORD[cell.state]}`];
  if (cell.state === "closed" && cell.reason) parts[0] = `${symbol}, ${dayLong(cell.day)}: ${cell.reason}`;
  if (cell.state !== "closed" || cell.bars > 0) {
    parts.push(cell.expected ? `${de(cell.bars)} von ${de(cell.expected)} Balken erwartet` : `${de(cell.bars)} Balken`);
  }
  if (cell.today && cell.state !== "closed") parts.push("der Tag läuft noch");
  if (cell.thin) parts.push("dünn gehandelt, das ist kein Fehler");
  return parts.join(", ");
}

/** The pause as "vor 5 Min.", "vor 3 Std.", "vor 2 Tagen"; "nie" without a time. */
export function ago(at: number | null, nowS: number): string {
  if (at === null) return "nie";
  const s = Math.max(0, nowS - at);
  if (s < 90) return "gerade eben";
  if (s < 5400) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 2 * 86400) return `vor ${Math.round(s / 3600)} Std.`;
  return `vor ${Math.floor(s / 86400)} Tagen`;
}

/** In the next minutes/hours/days: "in 3 Std.", "in 12 Min.". */
export function until(at: number | null, nowS: number): string {
  if (at === null) return "aus";
  const s = at - nowS;
  if (s < 60) return "gleich";
  if (s < 5400) return `in ${Math.round(s / 60)} Min.`;
  if (s < 2 * 86400) return `in ${Math.round(s / 3600)} Std.`;
  return `in ${Math.floor(s / 86400)} Tagen`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toLocaleString("de-DE", { maximumFractionDigits: 0 })} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
  return `${(n / 1024 ** 3).toLocaleString("de-DE", { maximumFractionDigits: 2 })} GB`;
}

export const CALL_COLUMNS: { kind: CallKind; label: string; hint: string }[] = [
  { kind: "200", label: "200", hint: "Antwort mit Daten" },
  { kind: "404", label: "404", hint: "leere Antwort: Feiertag oder Tag ohne Handel, kein Fehler" },
  { kind: "422", label: "422", hint: "Quelle lehnt Zeitraum oder Form ab" },
  { kind: "429", label: "429", hint: "Quelle drosselt" },
  { kind: "error", label: "Fehler", hint: "Netz oder Serverfehler" },
];

/** "09:00" from UTC seconds, in the browser's zone is not wanted: the server's day is UTC, so UTC it is. */
export const utcTime = (s: number) => new Date(s * 1000).toISOString().slice(11, 16);
