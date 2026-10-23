import { describe, expect, it } from "vitest";
import { MAX_TICK_MS, elapsedMs } from "../src/ws.js";

describe("elapsedMs", () => {
  it("is the time since the last tick", () => {
    expect(elapsedMs(1020, 1000)).toBe(20);
  });

  it("is capped, so a stalled server does not make the simulation jump", () => {
    expect(elapsedMs(100_000, 0)).toBe(MAX_TICK_MS);
    expect(MAX_TICK_MS).toBe(1000);
  });

  it("is never negative, so a clock that steps back cannot run the simulation backwards", () => {
    expect(elapsedMs(900, 1000)).toBe(0);
  });
});
