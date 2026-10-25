import { describe, expect, it } from "vitest";
import { gradeRun, letterOf, returnScale, type GradeInput } from "../src/domain/grade.js";

const base: GradeInput = {
  totalReturn: 0, benchmarkReturn: null, maxDrawdown: 0, feeShare: 0, hitRate: null, closedTrades: 0, filledOrders: 2, days: 365,
};

describe("letterOf", () => {
  it("cuts at 80, 65, 50 and 35", () => {
    expect([100, 80, 79.9, 65, 64.9, 50, 49.9, 35, 34.9, 0].map(letterOf)).toEqual(["A", "A", "B", "B", "C", "C", "D", "D", "E", "E"]);
  });
});

describe("returnScale", () => {
  it("is ten percent for a year, grows with the root of the time and never falls under one percent", () => {
    expect(returnScale(365)).toBeCloseTo(0.1, 12);
    expect(returnScale(4 * 365)).toBeCloseTo(0.2, 12);
    expect(returnScale(1)).toBe(0.01);
    expect(returnScale(0)).toBe(0.01);
  });
});

describe("gradeRun", () => {
  it("gives no grade without a trade", () => {
    const g = gradeRun({ ...base, filledOrders: 0 });
    expect(g.grade).toBeNull();
    expect(g.score).toBeNull();
    expect(g.note).toMatch(/Ohne Trade/);
  });

  it("gives no grade when the curve is too short to measure", () => {
    expect(gradeRun({ ...base, totalReturn: null }).grade).toBeNull();
    expect(gradeRun({ ...base, maxDrawdown: null }).note).toMatch(/zu wenige Punkte/);
  });

  it("scores a flat round with no fall and no fees: half for the return, full for the rest", () => {
    const g = gradeRun(base);
    // 0.4*50 + 0.3*100 + 0.15*100 over the weights 0.85 that count (no hit rate)
    expect(g.score).toBeCloseTo((0.4 * 50 + 0.3 * 100 + 0.15 * 100) / 0.85, 1);
    expect(g.parts.map((p) => p.key)).toEqual(["return", "risk", "costs"]);
    expect(g.parts.reduce((a, p) => a + p.weight, 0)).toBeCloseTo(1, 12);
    expect(g.note).toMatch(/Trefferquote zählt nicht/);
  });

  it("gives an A for a year at +10 %, no fall, no fees and every trade won", () => {
    const g = gradeRun({ ...base, totalReturn: 0.1, hitRate: 1, closedTrades: 4 });
    expect(g.score).toBe(100);
    expect(g.grade).toBe("A");
    expect(g.note).toBeNull();
  });

  it("gives an E for -10 %, a fall of 25 %, fees of 2 % and every trade lost", () => {
    const g = gradeRun({ ...base, totalReturn: -0.1, maxDrawdown: -0.25, feeShare: 0.02, hitRate: 0, closedTrades: 5 });
    expect(g.score).toBe(0);
    expect(g.grade).toBe("E");
  });

  it("judges the return against the benchmark when there is one", () => {
    const beat = gradeRun({ ...base, totalReturn: 0.05, benchmarkReturn: 0.05 });
    const flat = gradeRun(base);
    expect(beat.parts[0].score).toBe(50);
    expect(beat.parts[0].label).toBe("Ertrag gegen den Maßstab");
    expect(beat.score).toBe(flat.score);
    expect(gradeRun({ ...base, totalReturn: 0.0, benchmarkReturn: 0.1 }).parts[0].score).toBe(0);
  });

  it("makes a short round fair: the same +2 % earns more in two months than in two years", () => {
    const short = gradeRun({ ...base, totalReturn: 0.02, days: 60 }).parts[0].score;
    const long = gradeRun({ ...base, totalReturn: 0.02, days: 730 }).parts[0].score;
    expect(short).toBeGreaterThan(long);
  });

  it("does not count a hit rate from fewer than three closed trades", () => {
    expect(gradeRun({ ...base, hitRate: 1, closedTrades: 2 }).parts.some((p) => p.key === "hits")).toBe(false);
    expect(gradeRun({ ...base, hitRate: 1, closedTrades: 3 }).parts.some((p) => p.key === "hits")).toBe(true);
  });

  it("keeps the score between 0 and 100 for extreme figures", () => {
    const hi = gradeRun({ ...base, totalReturn: 50, hitRate: 1, closedTrades: 9 });
    const lo = gradeRun({ ...base, totalReturn: -1, maxDrawdown: -1, feeShare: 5, hitRate: 0, closedTrades: 9 });
    expect(hi.score).toBe(100);
    expect(lo.score).toBe(0);
  });
});
