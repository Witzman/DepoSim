import type { RulePreset, Rules } from "./types.js";

export const RELAXED: Rules = {
  preset: "relaxed", spreadFactor: 1, feeFactor: 1, pauseAllowed: true, tempoLocked: false, allowFork: true, maxPositions: null,
};

export const PRESET_LABEL: Record<RulePreset, string> = {
  relaxed: "Entspannt", realistic: "Realistisch", hardcore: "Hardcore", custom: "Eigene Regeln",
};

/** What each preset means, in one line, for the picker. */
export const PRESET_TEXT: Record<Exclude<RulePreset, "custom">, string> = {
  relaxed: "Pause und Tempo frei, Gebühren und Spread wie im Modell. Zum Üben.",
  realistic: "Wie Entspannt, aber ohne gratis Rückgängig. Zum Vergleichen mit echtem Handel.",
  hardcore: "Doppelter Spread und doppelte Gebühren, keine Pause, festes Tempo; Orders nur bei laufender Uhr.",
};

/** The one-line summary of the switches for a tooltip. */
export function describeRules(r: Rules): string {
  const parts = [`Spread ×${r.spreadFactor}`, `Gebühren ×${r.feeFactor}`];
  parts.push(r.pauseAllowed ? "Pause erlaubt" : "keine Pause");
  parts.push(r.tempoLocked ? "festes Tempo" : "Tempo frei");
  if (r.maxPositions !== null) parts.push(`höchstens ${r.maxPositions} Positionen`);
  return parts.join(" · ");
}
