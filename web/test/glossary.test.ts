import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HINT_RULES } from "../../server/src/domain/hints.js";
import { GLOSSARY, entryOf, reliabilityOf, searchGlossary } from "../src/glossary.js";

const source = (name: string) => readFileSync(new URL(`../src/components/${name}`, import.meta.url), "utf8");
const hintIds = (text: string) => [...text.matchAll(/<Hint id="([A-Za-z0-9]+)"/g)].map((m) => m[1]);

describe("glossary", () => {
  it("has unique ids and a text for every part that is required", () => {
    const ids = GLOSSARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of GLOSSARY) {
      expect(e.name, e.id).not.toBe("");
      expect(e.short, e.id).not.toBe("");
      expect(e.how, e.id).not.toBe("");
    }
  });

  it("explains every figure that the evaluation shows", () => {
    const ids = hintIds(source("Evaluation.tsx"));
    for (const id of ["return", "basis", "volatility", "maxDrawdown", "sharpe", "sortino", "calmar", "var95", "bestStep", "worstStep",
      "upShare", "beta", "alpha", "trackingError", "informationRatio", "hitShare", "correlation", "fees", "distribution",
      "concentration", "positionCorrelation", "riskShare", "diversificationRatio"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("explains the review of the trades", () => {
    const ids = hintIds(source("TradeReview.tsx"));
    for (const id of ["mae", "mfe", "exitEfficiency"]) {
      expect(ids, id).toContain(id);
      expect(entryOf(id), id).toBeDefined();
    }
  });

  it("explains the behaviour card", () => {
    const ids = hintIds(source("BehaviorCard.tsx"));
    for (const id of ["disposition", "turnover", "chasing", "afterLoss"]) {
      expect(ids, id).toContain(id);
      expect(entryOf(id), id).toBeDefined();
    }
  });

  it("explains every figure that the journal shows", () => {
    const ids = hintIds(source("Journal.tsx"));
    for (const id of ["hitRate", "holding", "expectancy", "avgWinLoss", "payoff", "profitFactor", "bestWorstTrade", "losingStreak", "tooEarly"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("has an entry for every hint in the components", () => {
    for (const file of ["Evaluation.tsx", "Journal.tsx"]) {
      for (const id of hintIds(source(file))) expect(entryOf(id), `${file}: ${id}`).toBeDefined();
    }
  });
});

describe("hints", () => {
  it("point every rule's 'Warum?' at a glossary entry", () => {
    for (const [rule, info] of Object.entries(HINT_RULES)) expect(entryOf(info.why), rule).toBeDefined();
  });
});

describe("searchGlossary", () => {
  it("finds Calmar by name, ignoring case", () => {
    expect(searchGlossary("calmar")[0].id).toBe("calmar");
  });

  it("finds an entry by an alias", () => {
    expect(searchGlossary("drawdown").map((e) => e.id)).toContain("maxDrawdown");
  });

  it("puts the name match before a text match", () => {
    const ids = searchGlossary("sharpe").map((e) => e.id);
    expect(ids[0]).toBe("sharpe");
    expect(ids).toContain("sortino");
  });

  it("returns everything for an empty query and nothing for nonsense", () => {
    expect(searchGlossary("  ")).toHaveLength(GLOSSARY.length);
    expect(searchGlossary("qwertzuiop")).toEqual([]);
  });
});

describe("reliabilityOf", () => {
  it("says it is too early without a basis", () => {
    expect(reliabilityOf({ basis: null, periodsPerYear: null })?.label).toBe("zu früh zu sagen");
  });

  it("flags five-minute values and no others", () => {
    expect(reliabilityOf({ basis: "5min", periodsPerYear: 24192 })?.label).toBe("Aussagekraft gering");
    expect(reliabilityOf({ basis: "hour", periodsPerYear: 2016 })).toBeNull();
    expect(reliabilityOf({ basis: "day", periodsPerYear: 252 })).toBeNull();
  });
});
