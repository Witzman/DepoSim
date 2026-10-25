/**
 * The grade of a finished round, A to E. Pure: figures in, grade and the parts it is made of out.
 * The formula is shown in the interface (`GRADE_FORMULA`), so a person can check it by hand.
 */

export type Letter = "A" | "B" | "C" | "D" | "E";

export interface GradeInput {
  /** Change of the depot from the first point to the last, as a ratio. Null with too few points. */
  totalReturn: number | null;
  /** The benchmark's change over the same time; null without a benchmark. */
  benchmarkReturn: number | null;
  /** The deepest fall from a peak, as a negative ratio (-0.12). */
  maxDrawdown: number | null;
  /** Commission and foreign fees as a share of the start capital. */
  feeShare: number;
  /** Share of closed trades that won, and how many were closed; null rate without any. */
  hitRate: number | null;
  closedTrades: number;
  /** Filled orders in the depot. A round without any has no grade. */
  filledOrders: number;
  /** How long the round ran, in days. */
  days: number;
}

export interface GradePart {
  key: "return" | "risk" | "costs" | "hits";
  label: string;
  /** 0 to 100. */
  score: number;
  /** Share of the grade; the weights of the parts that count add up to 1. */
  weight: number;
  /** In words, with the real number. */
  detail: string;
}

export interface Grade {
  /** Null when there is nothing to judge: no trade, or fewer than two points of the curve. */
  grade: Letter | null;
  /** 0 to 100, null with the grade. */
  score: number | null;
  parts: GradePart[];
  /** Why there is no grade, or a remark on how it came about. */
  note: string | null;
}

export const GRADE_FORMULA =
  "Note aus bis zu vier Teilen mit Punkten von 0 bis 100. Ertrag (40 %): Rendite, mit Maßstab der Abstand dazu; " +
  "50 Punkte bei 0, 100 ab +10 % Jahresmaß, 0 ab -10 %, das Maß wächst mit der Wurzel der Dauer. " +
  "Risiko (30 %): größter Rückgang, 100 ohne Rückgang, 0 ab 25 %. " +
  "Kosten (15 %): Gebühren am Startkapital, 100 ohne, 0 ab 2 %. " +
  "Trefferquote (15 %): Anteil gewonnener Trades, nur ab 3 geschlossenen Trades, sonst zählen die anderen Teile mehr. " +
  "A ab 80, B ab 65, C ab 50, D ab 35, sonst E. Ohne Trade gibt es keine Note.";

const WEIGHTS = { return: 0.4, risk: 0.3, costs: 0.15, hits: 0.15 } as const;
/** Fewer closed trades say nothing about a hit rate. */
export const MIN_CLOSED_FOR_HITS = 3;
const RETURN_SCALE = 0.1;
const MIN_SCALE = 0.01;
const DRAWDOWN_ZERO = 0.25;
const FEES_ZERO = 0.02;
const YEAR_DAYS = 365;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")} %`;

/** The return that earns full points in a round of this length: ten percent a year, scaled by the root of the time. */
export function returnScale(days: number): number {
  return Math.max(MIN_SCALE, RETURN_SCALE * Math.sqrt(Math.max(days, 0) / YEAR_DAYS));
}

export function letterOf(score: number): Letter {
  return score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : score >= 35 ? "D" : "E";
}

export function gradeRun(i: GradeInput): Grade {
  if (i.filledOrders === 0) return { grade: null, score: null, parts: [], note: "Ohne Trade gibt es keine Note." };
  if (i.totalReturn === null || i.maxDrawdown === null) {
    return { grade: null, score: null, parts: [], note: "Die Kurve hat zu wenige Punkte für eine Note." };
  }
  const scale = returnScale(i.days);
  const gap = i.benchmarkReturn === null ? i.totalReturn : i.totalReturn - i.benchmarkReturn;
  const parts: GradePart[] = [
    {
      key: "return", label: i.benchmarkReturn === null ? "Ertrag" : "Ertrag gegen den Maßstab", weight: WEIGHTS.return,
      score: clamp(50 + 50 * (gap / scale), 0, 100),
      detail: i.benchmarkReturn === null ? `Rendite ${pct(i.totalReturn)}` : `Rendite ${pct(i.totalReturn)}, Maßstab ${pct(i.benchmarkReturn)}`,
    },
    {
      key: "risk", label: "Risiko", weight: WEIGHTS.risk,
      score: clamp(100 * (1 - -i.maxDrawdown / DRAWDOWN_ZERO), 0, 100), detail: `Größter Rückgang ${pct(-i.maxDrawdown)}`,
    },
    {
      key: "costs", label: "Kosten", weight: WEIGHTS.costs,
      score: clamp(100 * (1 - i.feeShare / FEES_ZERO), 0, 100), detail: `Gebühren ${pct(i.feeShare)} des Startkapitals`,
    },
  ];
  let note: string | null = null;
  if (i.hitRate !== null && i.closedTrades >= MIN_CLOSED_FOR_HITS) {
    parts.push({
      key: "hits", label: "Trefferquote", weight: WEIGHTS.hits, score: clamp(100 * i.hitRate, 0, 100),
      detail: `${pct(i.hitRate)} von ${i.closedTrades} geschlossenen Trades im Plus`,
    });
  } else {
    note = `Trefferquote zählt nicht: nur ${i.closedTrades} geschlossene${i.closedTrades === 1 ? "r Trade" : " Trades"}, ab ${MIN_CLOSED_FOR_HITS} zählt sie.`;
  }
  const total = parts.reduce((a, p) => a + p.weight, 0);
  const normed = parts.map((p) => ({ ...p, weight: p.weight / total }));
  const score = Math.round(normed.reduce((a, p) => a + p.score * p.weight, 0) * 10) / 10;
  return { grade: letterOf(score), score, parts: normed, note };
}
