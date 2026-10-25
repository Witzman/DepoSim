import { describe, expect, it } from "vitest";
import { benchmarkText, efficiencyText, entryText } from "../src/review.js";
import type { Excursion } from "../src/types.js";

const e = (o: Partial<Excursion> = {}): Excursion => ({
  maePct: 3, mfePct: 10, maeCents: 300, mfeCents: 1000, efficiency: 0.38, entryPosition: 0.1, bars: 5, benchmark: null, path: [], ...o,
});

describe("review texts", () => {
  it("say how much of the possible gain the exit took", () => {
    expect(efficiencyText(e())).toMatch(/38,00\s?% des möglichen Gewinns.*10,00\s?% höher/);
  });
  it("say there was no gain to take, or that the exit lay under the entry", () => {
    expect(efficiencyText(e({ efficiency: null, mfePct: 0 }))).toMatch(/nie über deinem Einstand/);
    expect(efficiencyText(e({ efficiency: -0.5 }))).toMatch(/Ausstieg lag darunter/);
  });
  it("say 'nicht berechenbar' instead of a guess without bars, entry range or benchmark", () => {
    expect(efficiencyText(e({ bars: 0, maePct: null, mfePct: null, efficiency: null }))).toMatch(/nicht berechenbar/);
    expect(entryText(e({ entryPosition: null }))).toMatch(/nicht berechenbar/);
    expect(benchmarkText(e())).toMatch(/nicht berechenbar/);
  });
  it("place the entry in the day's range and compare with the benchmark", () => {
    expect(entryText(e({ entryPosition: 0.1 }))).toMatch(/nahe am Tagestief/);
    expect(entryText(e({ entryPosition: 0.9 }))).toMatch(/nahe am Tageshoch/);
    expect(entryText(e({ entryPosition: 0.5 }))).toMatch(/Mitte/);
    expect(benchmarkText(e({ benchmark: { symbol: "EUNL.DE", pnl: 200, diff: 300 } }))).toMatch(/EUNL\.DE.*darüber/);
    expect(benchmarkText(e({ benchmark: { symbol: "EUNL.DE", pnl: 800, diff: -300 } }))).toMatch(/darunter/);
  });
});
