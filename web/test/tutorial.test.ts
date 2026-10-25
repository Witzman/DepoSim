import { describe, expect, it } from "vitest";
import { DONE, type GuideFacts, STEPS, doneSteps, parseGuide, showsFirstTime, targetOf } from "../src/guide.js";
import { buildEntries } from "../src/palette.js";

const facts = (over: Partial<GuideFacts> = {}): GuideFacts => ({ started: false, orders: [], seen: new Set(), ...over });
const order = (side: "buy" | "sell", kind: "market" | "limit", status: string) => ({ side, kind, status });

describe("steps", () => {
  it("are eight, in the order of the issue, each with a test and short German text", () => {
    expect(STEPS.map((s) => s.id)).toEqual(["start", "timeframe", "buy", "limit", "indicator", "drawing", "sell", "evaluation"]);
    for (const s of STEPS) {
      expect(DONE[s.id], s.id).toBeTypeOf("function");
      expect(s.text.split(/[.!?]\s/).length, s.id).toBeLessThanOrEqual(3);
    }
  });

  it("start with nothing done", () => {
    expect(doneSteps(facts(), [])).toEqual([]);
  });

  it("recognise each completion", () => {
    expect(doneSteps(facts({ started: true }), [])).toEqual(["start"]);
    expect(doneSteps(facts({ orders: [order("buy", "market", "filled")] }), [])).toEqual(["buy"]);
    expect(doneSteps(facts({ orders: [order("buy", "market", "open")] }), [])).toEqual([]);
    expect(doneSteps(facts({ orders: [order("buy", "limit", "open")] }), [])).toEqual(["limit"]);
    expect(doneSteps(facts({ orders: [order("sell", "limit", "rejected")] }), [])).toEqual([]);
    expect(doneSteps(facts({ orders: [order("sell", "market", "filled")] }), [])).toEqual(["sell"]);
    expect(doneSteps(facts({ seen: new Set(["timeframe", "indicator", "drawing"]) }), [])).toEqual(["timeframe", "indicator", "drawing"]);
  });

  it("need the evaluation and a benchmark for the last step", () => {
    expect(doneSteps(facts({ seen: new Set(["evaluation"]) }), [])).toEqual([]);
    expect(doneSteps(facts({ seen: new Set(["evaluation", "benchmark"]) }), [])).toEqual(["evaluation"]);
  });

  it("stay done once latched, even when the simulation is gone", () => {
    expect(doneSteps(facts(), ["start", "buy"])).toEqual(["start", "buy"]);
  });
});

describe("targets", () => {
  it("point at the new-simulation button until there is one, then at Start", () => {
    expect(targetOf("start", facts(), 0)).toBe("new-sim");
    expect(targetOf("start", facts(), 2)).toBe("start");
  });

  it("move from the evaluation tab to the benchmark selector", () => {
    expect(targetOf("evaluation", facts(), 1)).toBe("tab-evaluation");
    expect(targetOf("evaluation", facts({ seen: new Set(["evaluation"]) }), 1)).toBe("benchmark");
  });
});

describe("storage", () => {
  it("reads what was written and ignores the rest", () => {
    expect(parseGuide(JSON.stringify({ dismissed: false, seen: ["a", 1], done: ["start"] }))).toEqual({ dismissed: false, seen: ["a"], done: ["start"] });
    expect(parseGuide(null)).toBeNull();
    expect(parseGuide("{")).toBeNull();
    expect(parseGuide(JSON.stringify({ seen: [] }))).toBeNull();
  });

  it("shows itself the first time only to someone without a simulation", () => {
    expect(showsFirstTime(0)).toBe(true);
    expect(showsFirstTime(3)).toBe(false);
  });
});

describe("palette", () => {
  it("offers the guide as a command", () => {
    expect(buildEntries("lernpfad", [], [], [], ["guide"])).toEqual([{ kind: "command", id: "guide", label: "Lernpfad starten" }]);
  });
});
