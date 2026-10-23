import { describe, expect, it } from "vitest";
import { pickInitial } from "../src/select.js";

const sims = (...ids: number[]) => ids.map((id) => ({ id }));

describe("pickInitial", () => {
  it("is nothing when there are no simulations", () => {
    expect(pickInitial([], 3)).toBeNull();
    expect(pickInitial([], null)).toBeNull();
  });

  it("is the one used last, when it still exists", () => {
    expect(pickInitial(sims(1, 2, 3), 2)).toBe(2);
  });

  it("is the newest one when the last used is gone or unknown", () => {
    expect(pickInitial(sims(1, 2, 3), 9)).toBe(3);
    expect(pickInitial(sims(1, 2, 3), null)).toBe(3);
  });
});
