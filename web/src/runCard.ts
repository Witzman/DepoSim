import { z } from "zod";
import { formatEur, formatPercentPlain, signedPercent } from "./format.js";
import { PRESET_LABEL } from "./rules.js";
import { formatSimTime } from "./time.js";
import { starText } from "./scenarioStars.js";
import type { RunSummary } from "./types.js";

/** The card of a round as it is shared: figures and the name of the round, nothing else about the person. */
const cardShape = z.object({
  app: z.literal("deposim"),
  v: z.literal(1),
  kind: z.literal("run"),
  name: z.string().max(80),
  scenarioId: z.string().regex(/^[a-z0-9-]+$/).nullable(),
  preset: z.enum(["relaxed", "realistic", "hardcore", "custom"]),
  startAt: z.number().int(),
  endAt: z.number().int(),
  grade: z.enum(["A", "B", "C", "D", "E"]).nullable(),
  score: z.number().min(0).max(100).nullable(),
  stars: z.number().int().min(0).max(3).nullable(),
  totalReturn: z.number().nullable(),
  benchmarkSymbol: z.string().max(20).nullable(),
  benchmarkReturn: z.number().nullable(),
  maxDrawdown: z.number().nullable(),
  feeShare: z.number().min(0),
  trades: z.number().int().min(0),
});

export type RunCard = z.infer<typeof cardShape>;

export function toCard(run: RunSummary): RunCard {
  return {
    app: "deposim", v: 1, kind: "run", name: run.name, scenarioId: run.scenarioId, preset: run.preset, startAt: run.startAt,
    endAt: run.simulationTime, grade: run.grade.grade, score: run.grade.score, stars: run.scenario ? run.scenario.stars : null,
    totalReturn: run.totalReturn, benchmarkSymbol: run.benchmarkSymbol, benchmarkReturn: run.benchmarkReturn,
    maxDrawdown: run.maxDrawdown, feeShare: run.feeShare, trades: run.trades,
  };
}

export const serializeCard = (run: RunSummary): string => JSON.stringify(toCard(run), null, 2);

export type ParsedCard = { ok: true; card: RunCard } | { ok: false; reason: string };

/** A pasted card. Everything that is not a card of this version is turned away with a reason in words. */
export function parseCard(text: string): ParsedCard {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "Das ist keine Karte: der Text ist kein JSON." };
  }
  const r = cardShape.safeParse(raw);
  if (!r.success) return { ok: false, reason: "Das ist keine Karte dieser Version von DepoSim." };
  return { ok: true, card: r.data };
}

const pct = (x: number | null) => (x === null ? "—" : signedPercent(x));

/** The copyable text of a round, one block of a few lines. */
export function cardText(run: RunSummary): string {
  const day = run.resolution === "day";
  const lines = [
    `DepoSim · ${run.name}`,
    `${run.grade.grade ? `Note ${run.grade.grade} (${run.grade.score?.toFixed(1).replace(".", ",")} Punkte)` : "Ohne Note"} · Rendite ${pct(run.totalReturn)}` +
      (run.benchmarkSymbol ? ` · Maßstab ${run.benchmarkSymbol} ${pct(run.benchmarkReturn)}` : ""),
    `Größter Rückgang ${formatPercentPlain(run.maxDrawdown === null ? null : -run.maxDrawdown)} · Gebühren ${formatPercentPlain(run.feeShare)} · ${run.trades} Aufträge · Endwert ${formatEur(run.finalValue)}`,
    `${run.scenarioTitle ? `${run.scenarioTitle}${run.scenario ? ` ${starText(run.scenario.stars)}` : ""} · ` : ""}Regeln: ${PRESET_LABEL[run.preset]}`,
    `Zeitraum ${formatSimTime(run.startAt, day)} bis ${formatSimTime(run.simulationTime, day)}`,
  ];
  return lines.join("\n");
}
