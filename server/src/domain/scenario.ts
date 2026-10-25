import { z } from "zod";
import type { Cent } from "./money.js";

const goalShape = z.discriminatedUnion("kind", [
  /** The final value, as a share of the start capital (1.05: at least +5 %). */
  z.object({ kind: z.literal("endValue"), min: z.number().positive() }),
  /** Better than the benchmark's price over the same time. */
  z.object({ kind: z.literal("beatBenchmark") }),
  /** The deepest fall from a peak at most this share (0.15: 15 %). */
  z.object({ kind: z.literal("maxDrawdown"), max: z.number().positive().max(1) }),
  /** Commission and foreign fees at most this share of the start capital. */
  z.object({ kind: z.literal("fees"), max: z.number().positive().max(1) }),
]);

export type Goal = z.infer<typeof goalShape>;

const scenarioShape = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(60),
  /** A short story in German. */
  story: z.string().min(1).max(600),
  difficulty: z.enum(["leicht", "mittel", "schwer"]),
  resolution: z.enum(["minute", "day"]),
  /** UTC seconds. A daily scenario starts at a midnight and plays the days before `endAt`. */
  startAt: z.number().int().positive(),
  endAt: z.number().int().positive(),
  startCash: z.number().int().positive(),
  preset: z.enum(["relaxed", "realistic", "hardcore"]),
  /** Symbols that make sense here; shown, not enforced. */
  symbols: z.array(z.string()).min(1),
  benchmark: z.string().nullable(),
  main: goalShape,
  bonus: z.array(goalShape).max(2),
}).refine((s) => s.endAt > s.startAt, { message: "endAt must be after startAt", path: ["endAt"] })
  .refine((s) => s.benchmark !== null || ![s.main, ...s.bonus].some((g) => g.kind === "beatBenchmark"), {
    message: "beatBenchmark needs a benchmark", path: ["benchmark"],
  });

export type Scenario = z.infer<typeof scenarioShape>;

const utc = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

/** The scenarios that come with the game. The data of a daily scenario is in Yahoo's daily prices since 2019-11. */
const RAW: Scenario[] = [
  {
    id: "corona-crash-2020",
    title: "Corona-Crash 2020",
    story: "Mitte Februar 2020 steht der Weltmarkt auf einem Hoch. Wenige Wochen später fallen die Börsen so schnell wie selten. Du hast 10.000 Euro: Komm durch den Einbruch und liege Ende April vor dem Weltindex.",
    difficulty: "schwer",
    resolution: "day",
    startAt: utc("2020-02-14"),
    endAt: utc("2020-05-01"),
    startCash: 1_000_000,
    preset: "realistic",
    symbols: ["EUNL.DE", "SXR8.DE", "SAP.DE", "ALV.DE", "4GLD.DE"],
    benchmark: "EUNL.DE",
    main: { kind: "beatBenchmark" },
    bonus: [{ kind: "maxDrawdown", max: 0.15 }, { kind: "fees", max: 0.01 }],
  },
  {
    id: "zinswende-2022",
    title: "Zinswende 2022",
    story: "2022 steigen die Zinsen, Aktien und Anleihen fallen gemeinsam. Du hast 10.000 Euro und das Jahr bis Mitte Oktober: Begrenze den Rückgang auf 20 Prozent, und wenn du kannst, schlage den Weltindex.",
    difficulty: "mittel",
    resolution: "day",
    startAt: utc("2022-01-03"),
    endAt: utc("2022-10-15"),
    startCash: 1_000_000,
    preset: "realistic",
    symbols: ["EUNL.DE", "VWCE.DE", "SXR8.DE", "4GLD.DE", "SAP.DE"],
    benchmark: "EUNL.DE",
    main: { kind: "maxDrawdown", max: 0.2 },
    bonus: [{ kind: "beatBenchmark" }, { kind: "fees", max: 0.01 }],
  },
  {
    id: "rallye-2023",
    title: "Rallye 2023",
    story: "Anfang 2023 erholen sich die Märkte. Du hast 10.000 Euro und ein halbes Jahr: Erziele mindestens 5 Prozent Gewinn, ohne zwischendurch mehr als 10 Prozent zu verlieren.",
    difficulty: "leicht",
    resolution: "day",
    startAt: utc("2023-01-02"),
    endAt: utc("2023-07-01"),
    startCash: 1_000_000,
    preset: "relaxed",
    symbols: ["EUNL.DE", "VWCE.DE", "SXR8.DE", "SXRV.DE", "SAP.DE"],
    benchmark: "EUNL.DE",
    main: { kind: "endValue", min: 1.05 },
    bonus: [{ kind: "maxDrawdown", max: 0.1 }, { kind: "beatBenchmark" }],
  },
];

export const SCENARIOS: Scenario[] = RAW.map((s) => scenarioShape.parse(s));
export const scenarioById = (id: string): Scenario | undefined => SCENARIOS.find((s) => s.id === id);

export interface GoalInput {
  startCash: Cent;
  finalValue: Cent;
  /** The deepest fall from a peak as a negative ratio (-0.12), or null with too few points. */
  maxDrawdown: number | null;
  /** The depot's change from the first point, as a ratio, and the benchmark's. */
  depotReturn: number | null;
  benchmarkReturn: number | null;
  fees: Cent;
}

export interface GoalResult {
  kind: Goal["kind"];
  role: "main" | "bonus";
  label: string;
  met: boolean;
  /** What was reached, in words with the real number, or "—" when it cannot be told yet. */
  actual: string;
}

export interface GoalOutcome {
  /** 0 when the main goal is missed; 1 for the main goal, +1 for each bonus goal met. */
  stars: number;
  goals: GoalResult[];
}

const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")} %`;
const eur = (c: Cent) => `${(c / 100).toFixed(2).replace(".", ",")} €`;

function judge(goal: Goal, role: GoalResult["role"], i: GoalInput): GoalResult {
  switch (goal.kind) {
    case "endValue": {
      const ratio = i.startCash > 0 ? i.finalValue / i.startCash : 0;
      return {
        kind: goal.kind, role, met: ratio >= goal.min, actual: `${eur(i.finalValue)} (${pct(ratio - 1)})`,
        label: goal.min >= 1 ? `Endwert mindestens ${pct(goal.min - 1)} über dem Start` : `Endwert höchstens ${pct(1 - goal.min)} unter dem Start`,
      };
    }
    case "beatBenchmark": {
      const known = i.depotReturn !== null && i.benchmarkReturn !== null;
      return {
        kind: goal.kind, role, met: known && (i.depotReturn as number) > (i.benchmarkReturn as number), label: "Besser als der Maßstab",
        actual: known ? `Depot ${pct(i.depotReturn as number)}, Maßstab ${pct(i.benchmarkReturn as number)}` : "—",
      };
    }
    case "maxDrawdown": {
      const fall = i.maxDrawdown === null ? null : -i.maxDrawdown;
      return {
        kind: goal.kind, role, met: fall !== null && fall <= goal.max, label: `Größter Rückgang höchstens ${pct(goal.max)}`,
        actual: fall === null ? "—" : pct(fall),
      };
    }
    case "fees": {
      const share = i.startCash > 0 ? i.fees / i.startCash : 0;
      return { kind: goal.kind, role, met: share <= goal.max, label: `Gebühren höchstens ${pct(goal.max)} des Startkapitals`, actual: `${eur(i.fees)} (${pct(share)})` };
    }
  }
}

/** The goals of a scenario against what a depot reached. Pure: the curve and the fees go in, the stars come out. */
export function evaluateGoals(scenario: Pick<Scenario, "main" | "bonus">, input: GoalInput): GoalOutcome {
  const goals = [judge(scenario.main, "main", input), ...scenario.bonus.map((g) => judge(g, "bonus", input))];
  const main = goals[0].met;
  return { stars: main ? 1 + goals.slice(1).filter((g) => g.met).length : 0, goals };
}
