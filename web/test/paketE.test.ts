import { describe, expect, it } from "vitest";
import { formatDuration, arrowOf, signedEurArrow } from "../src/format.js";
import { elapsedSeries, toggleChoice, MAX_COMPARE } from "../src/compare.js";
import { throttleDelay } from "../src/throttle.js";
import { canGhost, pickDepot } from "../src/view.js";
import { buildEntries, COMMANDS } from "../src/palette.js";

describe("formatDuration", () => {
  it("shows the two largest units, German", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(20)).toBe("unter 1 Min");
    expect(formatDuration(45 * 60)).toBe("45 Min");
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe("2 Std 5 Min");
    expect(formatDuration(3 * 86400 + 4 * 3600 + 59)).toBe("3 T 4 Std");
    expect(formatDuration(86400)).toBe("1 T");
  });
});

describe("arrowOf / signedEurArrow", () => {
  it("never relies on colour alone", () => {
    expect(arrowOf(5)).toBe("▲");
    expect(arrowOf(-5)).toBe("▼");
    expect(arrowOf(0)).toBe("•");
    expect(signedEurArrow(1000)).toMatch(/^▲ \+10,00/);
    expect(signedEurArrow(-1000)).toMatch(/^▼ -10,00/);
  });
});

describe("toggleChoice", () => {
  it("adds, removes and stops at the maximum", () => {
    expect(toggleChoice([], 3)).toEqual([3]);
    expect(toggleChoice([3, 4], 3)).toEqual([4]);
    expect(toggleChoice([1, 2, 3, 4], 5)).toEqual([1, 2, 3, 4]);
    expect(MAX_COMPARE).toBe(4);
  });
});

describe("elapsedSeries", () => {
  it("counts from the own start and drops points that do not move on", () => {
    expect(elapsedSeries([{ t: 100, pct: 0 }, { t: 160, pct: 1 }, { t: 160, pct: 2 }, { t: 150, pct: 3 }, { t: 220, pct: -1 }]))
      .toEqual([{ time: 0, value: 0 }, { time: 60, value: 1 }, { time: 120, value: -1 }]);
    expect(elapsedSeries([])).toEqual([]);
  });
});

describe("throttleDelay", () => {
  it("is zero when nothing was fetched or the pause is over, else the rest", () => {
    expect(throttleDelay(null, 1000, 5000)).toBe(0);
    expect(throttleDelay(1000, 7000, 5000)).toBe(0);
    expect(throttleDelay(1000, 3000, 5000)).toBe(3000);
  });
});

describe("canGhost / pickDepot", () => {
  const normal = (id: number, n: number) => ({ id, kind: "normal" as const, positions: Array.from({ length: n }, () => ({})) });
  it("needs a normal depot with a position, and says why not", () => {
    expect(canGhost(normal(1, 1))).toEqual({ ok: true });
    expect(canGhost(normal(1, 0))).toMatchObject({ ok: false, reason: expect.stringContaining("Position") });
    expect(canGhost({ kind: "ghost", positions: [{}] })).toMatchObject({ ok: false });
  });
  it("defaults to the first normal depot, not the first depot", () => {
    const ds = [{ id: 1, kind: "ghost" as const }, { id: 2, kind: "normal" as const }];
    expect(pickDepot(ds, null)?.id).toBe(2);
    expect(pickDepot(ds, 1)?.id).toBe(1);
    expect(pickDepot(ds, 9)?.id).toBe(2);
    expect(pickDepot([{ id: 1, kind: "ghost" as const }], null)?.id).toBe(1);
  });
});

describe("palette commands", () => {
  it("lists the available commands for an empty query and finds them by word", () => {
    const ids = COMMANDS.map((c) => c.id);
    const es = buildEntries("", [], [], [], ids);
    expect(es.filter((e) => e.kind === "command")).toHaveLength(ids.length);
    const hit = (q: string) => buildEntries(q, [], [], [], ids).filter((e) => e.kind === "command").map((e) => (e as { id: string }).id);
    expect(hit("nachladen")).toEqual(["backfill"]);
    expect(hit("geist")).toEqual(["ghost"]);
    expect(hit("journal")).toEqual(["journal"]);
    expect(hit("vergleich")).toEqual(["compare", "longterm"]); // both have "vergleich" in their name
    expect(hit("langzeit")).toEqual(["longterm"]);
    expect(hit("simulationsvergleich")).toEqual(["compare"]);
    expect(hit("orderbuch")).toEqual(["orderbook"]);
    expect(buildEntries("nachladen", [], [], [], [])).toEqual([]);
  });
});
