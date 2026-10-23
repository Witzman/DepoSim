import { describe, expect, it } from "vitest";
import { berlinToUtcSeconds, formatSimTime, lastTradingDay } from "../src/time.js";

describe("berlinToUtcSeconds", () => {
  it("converts summer time (UTC+2)", () => {
    expect(berlinToUtcSeconds("2026-10-23", "10:00")).toBe(1792742400); // 08:00 UTC
  });

  it("converts winter time (UTC+1), three days and one clock change later", () => {
    expect(berlinToUtcSeconds("2026-10-26", "10:00")).toBe(1792742400 + 3 * 86400 + 3600); // 09:00 UTC
  });

  it("is right on both sides of the spring change (2026-03-29, 02:00 jumps to 03:00)", () => {
    expect(berlinToUtcSeconds("2026-03-29", "01:30")).toBe(Date.UTC(2026, 2, 29, 0, 30) / 1000); // CET
    expect(berlinToUtcSeconds("2026-03-29", "03:30")).toBe(Date.UTC(2026, 2, 29, 1, 30) / 1000); // CEST
  });

  it("turns the 02:30 that does not exist on the spring change into the same instant as 03:30", () => {
    expect(berlinToUtcSeconds("2026-03-29", "02:30")).toBe(berlinToUtcSeconds("2026-03-29", "03:30"));
  });

  it("takes the first of the two 02:30 on the autumn change (2026-10-25), the summer-time one", () => {
    expect(berlinToUtcSeconds("2026-10-25", "02:30")).toBe(Date.UTC(2026, 9, 25, 0, 30) / 1000);
  });

  it("says so when the text is not a date and a time", () => {
    expect(() => berlinToUtcSeconds("gestern", "10:00")).toThrow();
    expect(() => berlinToUtcSeconds("2026-10-23", "25:00")).toThrow();
    expect(() => berlinToUtcSeconds("2026-02-30", "10:00")).toThrow();
  });
});

describe("formatSimTime", () => {
  it("shows German date and time in Berlin time", () => {
    expect(formatSimTime(1792742400)).toBe("23.10.2026, 10:00:00");
    expect(formatSimTime(1792742400 + 3 * 86400 + 3600)).toBe("26.10.2026, 10:00:00");
  });
});

describe("lastTradingDay", () => {
  const day = (iso: string) => lastTradingDay(new Date(iso));

  it("is yesterday from Tuesday to Friday", () => {
    expect(day("2026-10-21T12:00:00Z")).toBe("2026-10-20");
    expect(day("2026-10-23T12:00:00Z")).toBe("2026-10-22");
  });

  it("is the Friday before from Saturday, Sunday and Monday", () => {
    expect(day("2026-10-24T12:00:00Z")).toBe("2026-10-23");
    expect(day("2026-10-25T12:00:00Z")).toBe("2026-10-23");
    expect(day("2026-10-26T12:00:00Z")).toBe("2026-10-23");
  });

  it("counts the day in Berlin, not in UTC", () => {
    // 23:30 UTC on Sunday is already Monday 00:30 in Berlin: the last trading day is still Friday.
    expect(day("2026-10-25T23:30:00Z")).toBe("2026-10-23");
    // 23:30 UTC on Monday is already Tuesday in Berlin: yesterday there is Monday.
    expect(day("2026-10-26T23:30:00Z")).toBe("2026-10-26");
  });
});
