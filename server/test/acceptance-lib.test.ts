import { describe, expect, it } from "vitest";
import { lastTradingDayBefore } from "../scripts/acceptance-lib.js";

const day = (iso: string, tryBack = 0) => lastTradingDayBefore(new Date(iso), tryBack);

describe("lastTradingDayBefore", () => {
  it("is the Friday before from Saturday, Sunday and Monday", () => {
    expect(day("2026-10-24T12:00:00Z")).toBe("2026-10-23");
    expect(day("2026-10-25T12:00:00Z")).toBe("2026-10-23");
    expect(day("2026-10-26T12:00:00Z")).toBe("2026-10-23");
  });

  it("is yesterday from Tuesday to Friday", () => {
    expect(day("2026-10-27T12:00:00Z")).toBe("2026-10-26");
    expect(day("2026-10-23T12:00:00Z")).toBe("2026-10-22");
  });

  it("goes one more trading day back for each try, over the weekend", () => {
    expect(day("2026-10-26T12:00:00Z", 1)).toBe("2026-10-22");
    expect(day("2026-10-24T12:00:00Z", 1)).toBe("2026-10-22");
    expect(day("2026-10-27T12:00:00Z", 2)).toBe("2026-10-22");
    expect(day("2026-10-26T12:00:00Z", 5)).toBe("2026-10-16");
  });
});
