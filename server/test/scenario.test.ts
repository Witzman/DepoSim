import { describe, expect, it } from "vitest";
import { SCENARIOS, evaluateGoals, scenarioById } from "../src/domain/scenario.js";

const input = (over: Partial<Parameters<typeof evaluateGoals>[1]> = {}) => ({
  startCash: 1_000_000, finalValue: 1_100_000, maxDrawdown: -0.08, depotReturn: 0.1, benchmarkReturn: 0.05, fees: 5000, ...over,
});

describe("scenarios", () => {
  it("come with at least three, each valid, with unique ids and a benchmark that its goals need", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(s.endAt, s.id).toBeGreaterThan(s.startAt);
      expect(s.bonus.length, s.id).toBeLessThanOrEqual(2);
      expect(scenarioById(s.id)).toBe(s);
    }
  });

  it("begin where the daily prices are and end before today", () => {
    for (const s of SCENARIOS.filter((x) => x.resolution === "day")) {
      expect(s.startAt, s.id).toBeGreaterThanOrEqual(Date.parse("2019-11-01T00:00:00Z") / 1000);
      expect(s.startAt % 86400, s.id).toBe(0);
      expect(s.endAt, s.id).toBeLessThan(Date.parse("2024-01-01T00:00:00Z") / 1000);
    }
  });
});

describe("evaluateGoals", () => {
  const scenario = {
    main: { kind: "endValue", min: 1.05 } as const,
    bonus: [{ kind: "maxDrawdown", max: 0.1 } as const, { kind: "fees", max: 0.01 } as const],
  };

  it("gives three stars when the main and both bonus goals are met, with the real numbers", () => {
    const r = evaluateGoals(scenario, input());
    expect(r.stars).toBe(3);
    expect(r.goals.map((g) => g.met)).toEqual([true, true, true]);
    expect(r.goals[0].actual).toBe("11000,00 € (10,0 %)");
    expect(r.goals[1].actual).toBe("8,0 %");
  });

  it("gives no star when the main goal is missed, whatever the bonus", () => {
    expect(evaluateGoals(scenario, input({ finalValue: 1_040_000 })).stars).toBe(0);
  });

  it("counts a bonus goal only when it is met", () => {
    expect(evaluateGoals(scenario, input({ maxDrawdown: -0.12 })).stars).toBe(2);
    expect(evaluateGoals(scenario, input({ maxDrawdown: -0.12, fees: 20_000 })).stars).toBe(1);
  });

  it("takes the limits as inclusive: exactly 5 %, 10 % and 1 % pass", () => {
    const r = evaluateGoals(scenario, input({ finalValue: 1_050_000, maxDrawdown: -0.1, fees: 10_000 }));
    expect(r.stars).toBe(3);
  });

  it("beats the benchmark only when strictly better, and cannot tell without one", () => {
    const s = { main: { kind: "beatBenchmark" } as const, bonus: [] };
    expect(evaluateGoals(s, input({ depotReturn: 0.05, benchmarkReturn: 0.05 })).stars).toBe(0);
    expect(evaluateGoals(s, input({ depotReturn: 0.06, benchmarkReturn: 0.05 })).stars).toBe(1);
    const unknown = evaluateGoals(s, input({ benchmarkReturn: null }));
    expect(unknown.stars).toBe(0);
    expect(unknown.goals[0].actual).toBe("—");
  });

  it("cannot judge a drawdown that is not known yet", () => {
    const r = evaluateGoals({ main: { kind: "maxDrawdown", max: 0.2 }, bonus: [] }, input({ maxDrawdown: null }));
    expect(r.goals[0]).toMatchObject({ met: false, actual: "—" });
  });

  it("reads a main goal below the start as a limit on the loss", () => {
    const r = evaluateGoals({ main: { kind: "endValue", min: 0.95 }, bonus: [] }, input({ finalValue: 960_000 }));
    expect(r.goals[0].label).toBe("Endwert höchstens 5,0 % unter dem Start");
    expect(r.stars).toBe(1);
  });
});
