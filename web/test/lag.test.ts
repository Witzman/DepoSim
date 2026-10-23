import { describe, expect, it } from "vitest";
import { formatLag } from "../src/lag.js";

describe("formatLag", () => {
  it("says under a minute for less than a minute, also for nothing or a negative lag", () => {
    expect(formatLag(30)).toBe("unter 1 Min.");
    expect(formatLag(0)).toBe("unter 1 Min.");
    expect(formatLag(-50)).toBe("unter 1 Min.");
  });

  it("shows whole minutes below an hour", () => {
    expect(formatLag(60)).toBe("1 Min.");
    expect(formatLag(45 * 60 + 59)).toBe("45 Min.");
  });

  it("shows hours and minutes, and leaves out minutes that are zero", () => {
    expect(formatLag(2 * 3600)).toBe("2 Std.");
    expect(formatLag(3 * 3600 + 20 * 60 + 59)).toBe("3 Std. 20 Min.");
    expect(formatLag(3600)).toBe("1 Std.");
  });
});
