import type { Basis } from "./metrics.js";
import type { Cent } from "./money.js";

export type HintRule = "largest" | "top3" | "sector" | "usd" | "cashLow" | "cashHigh" | "fees" | "drawdown" | "losingStreak" | "turnover" | "disposition" | "data";
export type Severity = "info" | "warn";

export interface RuleConfig {
  enabled: boolean;
  /** Thresholds: for a two-level rule [info, warn], otherwise [threshold]. Shares are ratios (0.25 is 25 %). */
  levels: number[];
}

export interface RuleInfo {
  label: string;
  /** What the thresholds mean, for the settings. */
  unit: "share" | "count" | "none";
  /** The severity of a single-level rule. */
  severity: Severity;
  defaults: number[];
  /** Id of the glossary entry that explains the figure ("Warum?"). */
  why: string;
}

/** All thresholds in one place; the rules below read them from the config, never from their own code. */
export const HINT_RULES: Record<HintRule, RuleInfo> = {
  largest: { label: "Größte Position", unit: "share", severity: "info", defaults: [0.25, 0.4], why: "concentration" },
  top3: { label: "Größte drei Positionen", unit: "share", severity: "info", defaults: [0.7], why: "concentration" },
  sector: { label: "Ein Sektor", unit: "share", severity: "info", defaults: [0.4], why: "distribution" },
  usd: { label: "Dollar-Anteil", unit: "share", severity: "info", defaults: [0.5], why: "distribution" },
  cashLow: { label: "Wenig Guthaben", unit: "share", severity: "info", defaults: [0.02], why: "distribution" },
  cashHigh: { label: "Viel Guthaben", unit: "share", severity: "info", defaults: [0.6], why: "distribution" },
  fees: { label: "Gebühren", unit: "share", severity: "warn", defaults: [0.01], why: "fees" },
  drawdown: { label: "Rückgang vom Höchststand", unit: "share", severity: "info", defaults: [0.1, 0.2], why: "maxDrawdown" },
  losingStreak: { label: "Verlustserie", unit: "count", severity: "warn", defaults: [4], why: "losingStreak" },
  turnover: { label: "Umschlag", unit: "count", severity: "info", defaults: [3], why: "turnover" },
  disposition: { label: "Dispositionseffekt", unit: "count", severity: "info", defaults: [1.5], why: "disposition" },
  data: { label: "Datenlage", unit: "none", severity: "info", defaults: [], why: "basis" },
};

export const HINT_ORDER = Object.keys(HINT_RULES) as HintRule[];

export const defaultConfig = (): Record<HintRule, RuleConfig> =>
  Object.fromEntries(HINT_ORDER.map((r) => [r, { enabled: true, levels: [...HINT_RULES[r].defaults] }])) as Record<HintRule, RuleConfig>;

export interface Hint {
  rule: HintRule;
  severity: Severity;
  text: string;
  /** The measured value and the threshold it crossed, in the unit of the rule. */
  measure: number;
  threshold: number;
  unit: RuleInfo["unit"];
  why: string;
}

export interface HintInput {
  depotValue: Cent;
  cash: Cent;
  startCash: Cent;
  positions: { symbol: string; value: Cent; sector: string; currency: "EUR" | "USD" }[];
  /** The depot's value curve up to now, oldest first. */
  curve: { t: number; value: Cent }[];
  now: number;
  /** Fees booked over the start cash. */
  feeShareOfStart: number;
  trades: { netPnl: number; closedSim: number; sellOrderId: number }[];
  metricsBasis: Basis | null;
  /** From the behaviour figures of the journal; absent for a depot that does not trade. A figure is null while its sample is too small. */
  behavior?: { yearlyTurnover: number | null; dispositionRatio: number | null };
}

const pct = (x: number) => `${(x * 100).toFixed(x * 100 < 10 && x > 0 ? 1 : 0).replace(".", ",")} %`;
const DAY = 86400;
/** Sectors that say nothing about clumping. */
const NOT_A_SECTOR = new Set(["ETF/Fonds", "Unbekannt", "Guthaben"]);

/** The level reached by `value` among ascending `levels`: -1 for none. */
function levelReached(value: number, levels: number[]): number {
  let hit = -1;
  levels.forEach((l, i) => { if (value > l) hit = i; });
  return hit;
}

function severityAt(rule: HintRule, index: number, levels: number[]): Severity {
  return levels.length > 1 ? (index >= levels.length - 1 ? "warn" : "info") : HINT_RULES[rule].severity;
}

/** The longest run of losing trades at the end of the list, in closing order. */
export function currentLosingStreak(trades: HintInput["trades"]): number {
  const ordered = [...trades].sort((a, b) => a.closedSim - b.closedSim || a.sellOrderId - b.sellOrderId);
  let streak = 0;
  for (const t of ordered) streak = t.netPnl < 0 ? streak + 1 : 0;
  return streak;
}

/**
 * The rules that apply to the depot as it is now. Pure: only what is in `input`, which holds nothing
 * after the simulation time. An empty depot, or one with only cash, gets no concentration hints.
 */
export function evaluateHints(input: HintInput, config: Record<HintRule, RuleConfig> = defaultConfig()): Hint[] {
  const out: Hint[] = [];
  const total = input.depotValue;
  const held = input.positions.filter((p) => p.value > 0);
  const make = (rule: HintRule, idx: number, text: string, measure: number, threshold: number) => {
    out.push({ rule, severity: severityAt(rule, idx, config[rule].levels), text, measure, threshold, unit: HINT_RULES[rule].unit, why: HINT_RULES[rule].why });
  };
  const on = (rule: HintRule) => config[rule].enabled;

  if (total > 0 && held.length > 0) {
    const sorted = [...held].sort((a, b) => b.value - a.value);
    const largest = sorted[0].value / total;
    if (on("largest")) {
      const i = levelReached(largest, config.largest.levels);
      if (i >= 0) make("largest", i, `${sorted[0].symbol} ist ${pct(largest)} des Depotwerts. Ab ${pct(config.largest.levels[i])} bestimmt eine einzelne Position das Ergebnis stark.`, largest, config.largest.levels[i]);
    }
    if (on("top3") && held.length >= 3) {
      const top3 = sorted.slice(0, 3).reduce((a, p) => a + p.value, 0) / total;
      const t = config.top3.levels[0];
      if (top3 > t) make("top3", 0, `Die drei größten Positionen machen ${pct(top3)} des Depotwerts aus (Schwelle ${pct(t)}).`, top3, t);
    }
    if (on("sector")) {
      const bySector = new Map<string, number>();
      for (const p of held) if (!NOT_A_SECTOR.has(p.sector)) bySector.set(p.sector, (bySector.get(p.sector) ?? 0) + p.value);
      const [name, value] = [...bySector].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
      const t = config.sector.levels[0];
      if (value / total > t) make("sector", 0, `Der Sektor ${name} ist ${pct(value / total)} des Depotwerts (Schwelle ${pct(t)}).`, value / total, t);
    }
    if (on("usd")) {
      const usd = held.filter((p) => p.currency === "USD").reduce((a, p) => a + p.value, 0) / total;
      const t = config.usd.levels[0];
      if (usd > t) make("usd", 0, `${pct(usd)} des Depotwerts sind in Dollar, ohne Absicherung. Das bringt Wechselkursrisiko und Devisenaufschlag bei jedem Handel.`, usd, t);
    }
  }

  if (total > 0 && held.length > 0) {
    const cash = input.cash / total;
    if (on("cashLow") && cash < config.cashLow.levels[0]) {
      make("cashLow", 0, `Das Guthaben ist nur noch ${pct(Math.max(cash, 0))} des Depotwerts (Schwelle ${pct(config.cashLow.levels[0])}). Neue Käufe und Gebühren brauchen Platz.`, cash, config.cashLow.levels[0]);
    }
    if (on("cashHigh") && cash > config.cashHigh.levels[0]) {
      make("cashHigh", 0, `${pct(cash)} des Depotwerts liegen als Guthaben (Schwelle ${pct(config.cashHigh.levels[0])}).`, cash, config.cashHigh.levels[0]);
    }
  }

  if (on("fees") && input.feeShareOfStart > config.fees.levels[0]) {
    make("fees", 0, `Die Gebühren betragen ${pct(input.feeShareOfStart)} des Startkapitals (Schwelle ${pct(config.fees.levels[0])}). Viele kleine Orders kosten mit Mindestprovision und Auslandspauschale überproportional.`, input.feeShareOfStart, config.fees.levels[0]);
  }

  if (on("drawdown") && input.curve.length >= 2) {
    let peak = input.curve[0];
    for (const p of input.curve) if (p.value >= peak.value) peak = p;
    const last = input.curve[input.curve.length - 1];
    const fall = peak.value > 0 ? 1 - last.value / peak.value : 0;
    const i = levelReached(fall, config.drawdown.levels);
    if (i >= 0) {
      const days = Math.max(0, Math.floor((input.now - peak.t) / DAY));
      make("drawdown", i, `Das Depot liegt ${pct(fall)} unter dem Höchststand (Schwelle ${pct(config.drawdown.levels[i])}). Der Rückgang dauert seit ${days === 1 ? "1 Tag" : `${days} Tagen`}.`, fall, config.drawdown.levels[i]);
    }
  }

  if (on("losingStreak")) {
    const streak = currentLosingStreak(input.trades);
    const t = config.losingStreak.levels[0];
    if (streak >= t) make("losingStreak", 0, `Die letzten ${streak} abgeschlossenen Trades endeten im Minus (Schwelle ${t}). Auch gute Methoden haben Serien; bei wenigen Trades ist das oft Zufall.`, streak, t);
  }

  const turnover = input.behavior?.yearlyTurnover ?? null;
  if (on("turnover") && turnover !== null && turnover > config.turnover.levels[0]) {
    const t = config.turnover.levels[0];
    make("turnover", 0, `Das Kaufvolumen entspricht ${turnover.toFixed(1).replace(".", ",")}-mal dem mittleren Depot je Jahr (Schwelle ${String(t).replace(".", ",")}). Jede Order kostet; viel Handel braucht ein entsprechend großes Ergebnis vor Gebühren.`, turnover, t);
  }

  const ratio = input.behavior?.dispositionRatio ?? null;
  if (on("disposition") && ratio !== null && ratio > config.disposition.levels[0]) {
    const t = config.disposition.levels[0];
    make("disposition", 0, `Gewinne wurden ${ratio.toFixed(1).replace(".", ",")}-mal eher verkauft als Verluste (Schwelle ${String(t).replace(".", ",")}). Das Muster heißt Dispositionseffekt; mit wenigen Trades ist es oft Zufall.`, ratio, t);
  }

  if (on("data") && input.curve.length >= 2 && input.metricsBasis === null) {
    out.push({ rule: "data", severity: "info", text: "Für Volatilität, Sharpe und die anderen Kennzahlen liegen noch zu wenige Werte vor.", measure: 0, threshold: 0, unit: "none", why: "basis" });
  }

  return out.sort((a, b) => (a.severity === b.severity ? HINT_ORDER.indexOf(a.rule) - HINT_ORDER.indexOf(b.rule) : a.severity === "warn" ? -1 : 1));
}

/**
 * Remarks for the order ticket: what a buy would do to the weight of its position, and a foreign
 * flat fee that is large next to the order. `afterValue` is the position's value after the buy.
 */
export function orderNotes(o: {
  side: "buy" | "sell";
  symbol: string;
  /** The depot's value now; a buy swaps cash for shares, so it stays the same. */
  depotValue: Cent;
  afterValue: Cent;
  foreignFee: Cent;
  orderTotal: Cent;
}, config: Record<HintRule, RuleConfig> = defaultConfig()): string[] {
  const notes: string[] = [];
  if (o.side === "buy" && o.depotValue > 0 && config.largest.enabled) {
    const after = o.afterValue / o.depotValue;
    const t = config.largest.levels[0];
    if (after > t) notes.push(`Nach diesem Kauf wäre ${o.symbol} ${pct(after)} des Depotwerts (Schwelle ${pct(t)}).`);
  }
  if (config.fees.enabled && o.foreignFee > 0 && o.orderTotal > 0 && o.foreignFee / o.orderTotal > config.fees.levels[0]) {
    notes.push(`Die Auslandspauschale wäre ${pct(o.foreignFee / o.orderTotal)} der Order. Für die Pauschale ist die Order zu klein.`);
  }
  return notes;
}
