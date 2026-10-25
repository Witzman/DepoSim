import type { Behavior } from "./types.js";
import { formatDuration, formatEur, formatPercentPlain, formatRatio } from "./format.js";

export const tooEarlyText = (b: Behavior) => `Zu früh, um etwas zu sagen: ab ${b.minTrades} abgeschlossenen Trades gibt es hier Zahlen (jetzt ${b.trades}).`;

/** The disposition effect in words. Neutral: it describes, it does not judge. */
export function dispositionText(b: Behavior): string {
  const d = b.disposition;
  if (!d.ok || d.ratio === null || d.pgr === null || d.plr === null) return b.trades < b.minTrades ? tooEarlyText(b) : "Noch nicht genug Verkäufe mit offenen Verlusten oder Gewinnen daneben, um beide Anteile zu vergleichen.";
  if (d.ratio > 1.2) return `Gewinne wurden eher verkauft als Verluste (${formatPercentPlain(d.pgr)} gegen ${formatPercentPlain(d.plr)} der Gelegenheiten, Verhältnis ${formatRatio(d.ratio)}). Das Muster heißt Dispositionseffekt; eine Gegenmaßnahme ist, vorab ein Ziel und eine Verlustgrenze festzulegen.`;
  if (d.ratio < 0.8) return `Verluste wurden eher verkauft als Gewinne (${formatPercentPlain(d.plr)} gegen ${formatPercentPlain(d.pgr)}, Verhältnis ${formatRatio(d.ratio)}): das Gegenteil des üblichen Musters.`;
  return `Gewinne und Verluste wurden ähnlich oft verkauft (${formatPercentPlain(d.pgr)} gegen ${formatPercentPlain(d.plr)}, Verhältnis ${formatRatio(d.ratio)}).`;
}

export function holdingText(b: Behavior): string {
  const h = b.holding;
  if (!h.ok || h.winners.medianSeconds === null || h.losers.medianSeconds === null) return b.trades < b.minTrades ? tooEarlyText(b) : "Es braucht mindestens 3 Gewinner und 3 Verlierer für den Vergleich.";
  const w = h.winners.medianSeconds;
  const l = h.losers.medianSeconds;
  if (l > w * 1.5) return `Verlierer wurden länger gehalten als Gewinner (Median ${formatDuration(l)} gegen ${formatDuration(w)}).`;
  if (w > l * 1.5) return `Gewinner wurden länger gehalten als Verlierer (Median ${formatDuration(w)} gegen ${formatDuration(l)}).`;
  return `Gewinner und Verlierer wurden ähnlich lang gehalten (Median ${formatDuration(w)} gegen ${formatDuration(l)}).`;
}

export function turnoverText(b: Behavior): string {
  const t = b.turnover;
  if (!t.ok) return tooEarlyText(b);
  const parts: string[] = [];
  if (t.feeShare !== null) parts.push(`Gebühren machten ${formatPercentPlain(t.feeShare)} des Ergebnisses vor Gebühren aus${t.feeShare > 0.3 ? ": ein großer Teil des Gewinns ging an Kosten" : ""}.`);
  if (t.yearlyTurnover !== null) parts.push(`Das Kaufvolumen entspricht ${formatRatio(t.yearlyTurnover)}-mal dem mittleren Depot je Jahr.`);
  return parts.length ? parts.join(" ") : "Noch kein Gewinn vor Gebühren, an dem sich der Gebührenanteil messen ließe.";
}

export function chasingText(b: Behavior): string {
  const c = b.chasing;
  if (!c.ok || c.momentumShare === null || c.pullbackShare === null) return `Zu früh, um etwas zu sagen: ab ${b.minTrades} Käufen mit bekanntem Kurs von vor 5 Handelstagen gibt es hier Zahlen (jetzt ${c.n}).`;
  return `${formatPercentPlain(c.momentumShare)} der Käufe folgten auf einen Anstieg von mehr als 5 % in 5 Handelstagen, ${formatPercentPlain(c.pullbackShare)} auf einen Rücksetzer.`;
}

export function afterLossText(b: Behavior): string {
  const a = b.afterLoss;
  if (!a.ok || a.medianGapSeconds === null || a.baselineGapSeconds === null || a.medianSize === null || a.baselineSize === null) return b.trades < b.minTrades ? tooEarlyText(b) : "Es braucht mindestens 3 Verkäufe mit Verlust, auf die eine weitere Order folgte.";
  const faster = a.medianGapSeconds < a.baselineGapSeconds * 0.5;
  const bigger = a.medianSize > a.baselineSize * 1.5;
  const lead = faster && bigger ? "Nach einem Verlust kam die nächste Order schneller und größer als sonst" : faster ? "Nach einem Verlust kam die nächste Order schneller als sonst" : bigger ? "Nach einem Verlust war die nächste Order größer als sonst" : "Nach einem Verlust zeigte sich kein auffälliger Unterschied";
  return `${lead} (Abstand Median ${formatDuration(a.medianGapSeconds)} gegen ${formatDuration(a.baselineGapSeconds)}, Größe ${formatEur(a.medianSize)} gegen ${formatEur(a.baselineSize)}).`;
}
