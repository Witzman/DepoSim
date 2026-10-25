import type { Instrument, SearchHit, Simulation } from "./types.js";

export type Entry =
  | { kind: "instrument"; instrument: Instrument }
  | { kind: "simulation"; simulation: Simulation }
  | { kind: "theme" }
  | { kind: "help" }
  | { kind: "hit"; hit: SearchHit }
  | { kind: "command"; id: CommandId; label: string };

export type CommandId = "backfill" | "ghost" | "journal" | "compare" | "orderbook" | "longterm" | "backup";

/** The commands of Paket E; the palette gets the ids that make sense right now. */
export const COMMANDS: { id: CommandId; label: string; words: string[] }[] = [
  { id: "backfill", label: "Fehlende Kurse nachladen", words: ["nachladen", "kurse", "archiv", "lücken", "backfill"] },
  { id: "ghost", label: "Geisterdepot anlegen", words: ["geisterdepot", "geist", "einfrieren", "depot"] },
  { id: "journal", label: "Journal öffnen", words: ["journal", "trades", "trefferquote", "notiz", "auswertung"] },
  { id: "compare", label: "Simulationsvergleich öffnen", words: ["simulationsvergleich", "vergleich", "vergleichen", "auswertung"] },
  { id: "longterm", label: "Langzeitvergleich öffnen", words: ["langzeitvergleich", "langzeit", "vergleich", "etf", "dividende", "ausschüttung", "auswertung"] },
  { id: "backup", label: "Sicherung, Export und Import öffnen", words: ["sicherung", "backup", "wiederherstellen", "export", "import", "csv", "herunterladen"] },
  { id: "orderbook", label: "Orderbuch ein- oder ausklappen", words: ["orderbuch", "tiefe", "order", "handel"] },
];

const THEME_WORDS = ["hell", "dunkel", "farbe", "theme"];
const HELP_WORDS = ["kürzel", "tastenkürzel", "tasten", "hilfe"];

/**
 * What the palette shows for a query: the instruments of the list (symbols that start with the
 * query first), the simulations, the colour command, and last the search hits that are not in
 * the list yet.
 */
export function buildEntries(
  query: string,
  instruments: Instrument[],
  simulations: Simulation[],
  hits: SearchHit[],
  commandIds: CommandId[] = [],
): Entry[] {
  const commands = COMMANDS.filter((c) => commandIds.includes(c.id));
  const q = query.trim().toLowerCase();
  if (q === "") {
    return [
      ...instruments.map((instrument): Entry => ({ kind: "instrument", instrument })),
      ...simulations.map((simulation): Entry => ({ kind: "simulation", simulation })),
      ...commands.map((c): Entry => ({ kind: "command", id: c.id, label: c.label })),
      { kind: "theme" },
      { kind: "help" },
    ];
  }
  const matching = instruments.filter((i) => i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
  const starts = (i: Instrument) => (i.symbol.toLowerCase().startsWith(q) ? 0 : 1);
  const sorted = [...matching].sort((a, b) => starts(a) - starts(b)); // stable: the list's order otherwise

  const out: Entry[] = sorted.map((instrument) => ({ kind: "instrument", instrument }));
  for (const simulation of simulations) {
    if (simulation.name.toLowerCase().includes(q)) out.push({ kind: "simulation", simulation });
  }
  for (const c of commands) {
    if (c.label.toLowerCase().includes(q) || c.words.some((w) => w.includes(q))) out.push({ kind: "command", id: c.id, label: c.label });
  }
  if (THEME_WORDS.some((w) => w.includes(q))) out.push({ kind: "theme" });
  if (HELP_WORDS.some((w) => w.includes(q))) out.push({ kind: "help" });
  const listed = new Set(instruments.map((i) => i.symbol));
  for (const hit of hits) {
    if (!hit.known && !listed.has(hit.symbol)) out.push({ kind: "hit", hit });
  }
  return out;
}
