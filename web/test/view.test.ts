import { describe, expect, it } from "vitest";
import { normalize, pickDepot } from "../src/view.js";

describe("normalize", () => {
  it("starts at zero percent and shows the change against the first point", () => {
    expect(normalize([{ t: 1, value: 1000 }, { t: 2, value: 1100 }, { t: 3, value: 900 }])).toEqual([
      { t: 1, pct: 0 }, { t: 2, pct: 10 }, { t: 3, pct: -10 },
    ]);
  });

  it("gives nothing for no points or a first value of zero", () => {
    expect(normalize([])).toEqual([]);
    expect(normalize([{ t: 1, value: 0 }, { t: 2, value: 5 }])).toEqual([]);
  });
});

describe("pickDepot", () => {
  const depots = [{ id: 4 }, { id: 9 }];
  it("returns the chosen depot, or the first when the choice is gone or missing", () => {
    expect(pickDepot(depots, 9)).toEqual({ id: 9 });
    expect(pickDepot(depots, 77)).toEqual({ id: 4 });
    expect(pickDepot(depots, null)).toEqual({ id: 4 });
    expect(pickDepot([], 4)).toBeUndefined();
  });
});
