import { describe, expect, it } from "vitest";
import { concentrationOf, diversify } from "../src/domain/diversification.js";

const DAY = 86400;
const T0 = 1_760_000_000;
/** A daily price series from a list of daily returns. */
const series = (symbol: string, value: number, returns: number[], from = 0) => {
  let p = 100;
  const points = [{ t: T0 + from * DAY, value: p }];
  returns.forEach((r, i) => { p *= 1 + r; points.push({ t: T0 + (from + i + 1) * DAY, value: p }); });
  return { symbol, value, points };
};
const wiggle = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.02 : -0.015) + (i % 7) * 0.001);
const other = Array.from({ length: 30 }, (_, i) => ((i * 7) % 5 - 2) * 0.01);

describe("concentrationOf", () => {
  it("gives weights, top shares, HHI and the effective count by hand", () => {
    const c = concentrationOf([{ symbol: "A", value: 500 }, { symbol: "B", value: 300 }, { symbol: "C", value: 100 }, { symbol: "D", value: 100 }]);
    expect(c.weights.map((w) => w.symbol)).toEqual(["A", "B", "C", "D"]);
    expect(c.largest).toBeCloseTo(0.5, 12);
    expect(c.top3).toBeCloseTo(0.9, 12);
    expect(c.hhi).toBeCloseTo(0.25 + 0.09 + 0.01 + 0.01, 12);
    expect(c.effectiveCount).toBeCloseTo(1 / 0.36, 9);
  });

  it("is one effective position for one position and n for n equal ones", () => {
    expect(concentrationOf([{ symbol: "A", value: 7 }]).effectiveCount).toBeCloseTo(1, 12);
    expect(concentrationOf([1, 2, 3, 4].map((_, i) => ({ symbol: `S${i}`, value: 10 }))).effectiveCount).toBeCloseTo(4, 12);
  });
});

describe("diversify", () => {
  it("is null for an empty depot and has nothing to mix for one position", () => {
    expect(diversify([])).toBeNull();
    expect(diversify([series("A", 100, wiggle)])?.measured).toBeNull();
  });

  it("two identical positions: correlation 1, ratio 1, risk shares in line with the weights", () => {
    const r = diversify([series("A", 100, wiggle), series("B", 300, wiggle)])!.measured!;
    expect(r.matrix[0][1]).toBeCloseTo(1, 9);
    expect(r.ratio).toBeCloseTo(1, 9);
    expect(r.lines.find((l) => l.symbol === "B")!.riskShare).toBeCloseTo(0.75, 9);
    expect(r.remarks.join(" ")).toMatch(/laufen zu 1,0 gleich: wenig Streuung/);
  });

  it("two uncorrelated, equal-weight positions of equal volatility: ratio about the square root of two", () => {
    // +s, -s patterns that are orthogonal: the covariance is exactly zero.
    const a = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const b = Array.from({ length: 40 }, (_, i) => (Math.floor(i / 2) % 2 === 0 ? 0.01 : -0.01));
    const r = diversify([series("A", 100, a), series("B", 100, b)])!.measured!;
    expect(Math.abs(r.matrix[0][1])).toBeLessThan(0.05);
    expect(r.ratio).toBeCloseTo(Math.SQRT2, 1);
  });

  it("risk shares sum to one", () => {
    const r = diversify([series("A", 100, wiggle), series("B", 250, other), series("C", 50, wiggle.map((x, i) => x + other[i]))])!.measured!;
    expect(r.lines.reduce((a, l) => a + l.riskShare, 0)).toBeCloseTo(1, 9);
  });

  it("measures nothing with too few common values and says so", () => {
    const d = diversify([series("A", 100, wiggle.slice(0, 5)), series("B", 100, other.slice(0, 5))])!;
    expect(d.measured).toBeNull();
    expect(d.reason).toMatch(/zu wenige gemeinsame Werte/);
    expect(d.concentration.weights).toHaveLength(2);
  });

  it("leaves out a position that shares too little with the others and names it", () => {
    const lonely = series("L", 100, wiggle.slice(0, 3), 40);
    const r = diversify([series("A", 100, wiggle), series("B", 100, other), lonely])!.measured!;
    expect(r.left).toEqual(["L"]);
    expect(r.symbols).toEqual(["A", "B"]);
  });

  it("reports the last point that went in", () => {
    const r = diversify([series("A", 100, wiggle), series("B", 100, other)])!.measured!;
    expect(r.until).toBe(T0 + 30 * DAY);
  });
});
