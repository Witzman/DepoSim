import { describe, expect, it } from "vitest";
import { cardText, parseCard, serializeCard, toCard } from "../src/runCard.js";
import { rebase } from "../src/runCardImage.js";
import type { RunSummary } from "../src/types.js";

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: 3, name: "Meine Runde", startAt: Date.parse("2023-01-02T00:00:00Z") / 1000, simulationTime: Date.parse("2023-07-01T00:00:00Z") / 1000,
  endedAt: 1_700_000_000, finished: true, preset: "relaxed", resolution: "day", scenarioId: "rallye-2023", scenarioTitle: "Rallye 2023",
  startCash: 1_000_000, finalValue: 1_080_000, totalReturn: 0.08, benchmarkSymbol: "EUNL.DE", benchmarkReturn: 0.05, maxDrawdown: -0.04,
  fees: 1500, feeShare: 0.0015, trades: 3, hitRate: 1, closedTrades: 1,
  grade: { grade: "B", score: 72.4, parts: [], note: null }, gradeFormula: "x",
  scenario: { scenarioId: "rallye-2023", title: "Rallye 2023", finished: true, stars: 2, goals: [] },
  curve: { depot: [{ t: 1, value: 100 }, { t: 2, value: 108 }], benchmark: null },
  ...over,
});

describe("the card of a round", () => {
  it("round-trips through its text", () => {
    const parsed = parseCard(serializeCard(run()));
    expect(parsed).toEqual({ ok: true, card: toCard(run()) });
  });

  it("carries the figures and the name of the round and nothing else", () => {
    expect(Object.keys(toCard(run())).sort()).toEqual([
      "app", "benchmarkReturn", "benchmarkSymbol", "endAt", "feeShare", "grade", "kind", "maxDrawdown", "name", "preset", "scenarioId", "score", "stars", "startAt", "totalReturn", "trades", "v",
    ]);
  });

  it("turns away what is not a card, with a reason", () => {
    expect(parseCard("kein json")).toMatchObject({ ok: false, reason: expect.stringMatching(/kein JSON/) });
    expect(parseCard("{}")).toMatchObject({ ok: false, reason: expect.stringMatching(/keine Karte/) });
    expect(parseCard(JSON.stringify({ ...toCard(run()), v: 2 }))).toMatchObject({ ok: false });
    expect(parseCard(JSON.stringify({ ...toCard(run()), scenarioId: "../etc" }))).toMatchObject({ ok: false });
    expect(parseCard(JSON.stringify({ ...toCard(run()), grade: "F" }))).toMatchObject({ ok: false });
  });

  it("allows a free round without a scenario or a grade", () => {
    const free = run({ scenarioId: null, scenarioTitle: null, scenario: null, grade: { grade: null, score: null, parts: [], note: "x" } });
    expect(parseCard(serializeCard(free))).toMatchObject({ ok: true, card: { scenarioId: null, grade: null, stars: null } });
  });

  it("writes the text block with the grade, the benchmark, the scenario with its stars and the rules", () => {
    const t = cardText(run()).replace(/\u00a0/g, " "); // Intl writes a no-break space before % and €
    expect(t).toContain("DepoSim · Meine Runde");
    expect(t).toContain("Note B (72,4 Punkte)");
    expect(t).toContain("Rendite +8,00 %");
    expect(t).toContain("Maßstab EUNL.DE +5,00 %");
    expect(t).toContain("Rallye 2023 ★★☆");
    expect(t).toContain("Regeln: Entspannt");
    expect(t).toContain("02.01.2023 bis 01.07.2023");
    expect(cardText(run({ grade: { grade: null, score: null, parts: [], note: null } }))).toContain("Ohne Note");
  });
});

describe("rebase", () => {
  it("sets the first point to 100 and keeps the ratios", () => {
    expect(rebase([{ t: 1, value: 200 }, { t: 2, value: 250 }])).toEqual([{ t: 1, v: 100 }, { t: 2, v: 125 }]);
    expect(rebase([])).toEqual([]);
    expect(rebase([{ t: 1, value: 0 }])).toEqual([]);
  });
});
