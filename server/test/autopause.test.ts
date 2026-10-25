import { describe, expect, it } from "vitest";
import { DEFAULT_AUTOPAUSE, distanceToLimit, jumpOf, noSignals, parseAutoPause, pauseReason } from "../src/domain/autopause.js";
import { localToUtc, nextStop } from "../src/domain/clock.js";
import { VENUES } from "../src/config.js";

const venue = (id: string) => VENUES.find((v) => v.id === id)!;
const at = (iso: string) => Date.parse(iso) / 1000;

describe("parseAutoPause", () => {
  it("starts with every rule off", () => {
    expect(parseAutoPause(null)).toEqual(DEFAULT_AUTOPAUSE);
    expect(Object.entries(DEFAULT_AUTOPAUSE).filter(([, v]) => v === true)).toEqual([]);
  });

  it("keeps what is valid, bounds the numbers and drops the rest", () => {
    const p = parseAutoPause(JSON.stringify({ onFill: true, jump: "yes", jumpPct: 9, jumpMinutes: 0.2, nearLimitPct: -1, extra: 1 }));
    expect(p).toMatchObject({ onFill: true, jump: false, jumpPct: 0.5, jumpMinutes: 1, nearLimitPct: 0.0005 });
    expect("extra" in p).toBe(false);
    expect(parseAutoPause("not json")).toEqual(DEFAULT_AUTOPAUSE);
    expect(parseAutoPause([1, 2])).toEqual(DEFAULT_AUTOPAUSE);
  });
});

describe("distanceToLimit and jumpOf", () => {
  it("measures against the limit and the price before", () => {
    expect(distanceToLimit(100.3, 100)).toBeCloseTo(0.003, 12);
    expect(distanceToLimit(99.5, 100)).toBeCloseTo(0.005, 12);
    expect(distanceToLimit(1, 0)).toBeNull();
    expect(jumpOf(103, 100, 0.03)).toBeCloseTo(0.03, 12);
    expect(jumpOf(97, 100, 0.03)).toBeCloseTo(-0.03, 12);
    expect(jumpOf(102.9, 100, 0.03)).toBeNull();
    expect(jumpOf(100, 0, 0.03)).toBeNull();
  });
});

describe("pauseReason", () => {
  const on = { ...DEFAULT_AUTOPAUSE, onFill: true, onEvent: true, onOpen: true, nearLimit: true, jump: true };

  it("says nothing when nothing happened or the rule is off", () => {
    expect(pauseReason(on, noSignals())).toBeNull();
    expect(pauseReason(DEFAULT_AUTOPAUSE, { ...noSignals(), fills: ["Kauf 1 SAP.DE ausgeführt"] })).toBeNull();
  });

  it("names the reason with its rule, in a fixed order, and counts the rest", () => {
    const s = { fills: ["Kauf 10 SAP.DE ausgeführt"], bookings: ["Ausschüttung SAP.DE gebucht"], opened: [], near: [], jumps: ["SAP.DE +3,5 % in 10 Minuten"] };
    expect(pauseReason(on, s)).toEqual({ rule: "fill", reason: "Automatisch angehalten: Kauf 10 SAP.DE ausgeführt (und 2 weitere)" });
    expect(pauseReason({ ...on, onFill: false }, s)?.rule).toBe("event");
    expect(pauseReason({ ...DEFAULT_AUTOPAUSE, jump: true }, s)).toEqual({ rule: "jump", reason: "Automatisch angehalten: SAP.DE +3,5 % in 10 Minuten" });
    expect(pauseReason(on, { ...noSignals(), fills: ["a", "b"] })?.reason).toBe("Automatisch angehalten: a (und 1 weiteres)");
  });
});

describe("localToUtc", () => {
  it("finds the UTC second of a local time, in summer and winter time", () => {
    expect(localToUtc("Europe/Berlin", "2026-07-01", "17:30")).toBe(at("2026-07-01T15:30:00Z"));
    expect(localToUtc("Europe/Berlin", "2026-01-12", "17:30")).toBe(at("2026-01-12T16:30:00Z"));
    expect(localToUtc("America/New_York", "2026-07-01", "09:30")).toBe(at("2026-07-01T13:30:00Z"));
    expect(localToUtc("America/New_York", "2026-01-12", "16:00")).toBe(at("2026-01-12T21:00:00Z"));
  });

  it("is right on the day the clocks change", () => {
    // Berlin 2026-03-29: 02:00 CET becomes 03:00 CEST; 17:30 that day is CEST (UTC+2)
    expect(localToUtc("Europe/Berlin", "2026-03-29", "17:30")).toBe(at("2026-03-29T15:30:00Z"));
    expect(localToUtc("Europe/Berlin", "2026-10-25", "17:30")).toBe(at("2026-10-25T16:30:00Z"));
  });
});

describe("nextStop", () => {
  const xetra = venue("XETRA");

  it("ends an hour on, whatever the market does", () => {
    expect(nextStop("hour", 1000, xetra)).toBe(4600);
  });

  it("closes the same day during the session and opens the next trading day after it", () => {
    const tuesdayNoon = at("2026-10-27T11:00:00Z"); // 12:00 Berlin (CET after the change)
    expect(nextStop("close", tuesdayNoon, xetra)).toBe(at("2026-10-27T16:30:00Z"));
    expect(nextStop("open", tuesdayNoon, xetra)).toBe(at("2026-10-28T08:00:00Z"));
  });

  it("opens today before the opening and jumps to the next close after the close", () => {
    expect(nextStop("open", at("2026-10-27T06:00:00Z"), xetra)).toBe(at("2026-10-27T08:00:00Z"));
    expect(nextStop("close", at("2026-10-27T17:00:00Z"), xetra)).toBe(at("2026-10-28T16:30:00Z"));
  });

  it("skips a weekend", () => {
    const fridayEvening = at("2026-10-23T17:00:00Z");
    expect(nextStop("open", fridayEvening, xetra)).toBe(at("2026-10-26T08:00:00Z")); // Monday
  });

  it("skips a holiday", () => {
    // Xetra is shut on Good Friday 2026-04-03 and on Easter Monday, 2026-04-06: the next open is the Tuesday
    expect(nextStop("open", at("2026-04-02T17:00:00Z"), xetra)).toBe(at("2026-04-07T07:00:00Z"));
  });

  it("uses a short day's early close", () => {
    // the day after Thanksgiving, 2026-11-27, the US markets close at 13:00 New York time (18:00 UTC)
    expect(nextStop("close", at("2026-11-27T15:00:00Z"), venue("US"))).toBe(at("2026-11-27T18:00:00Z"));
    expect(nextStop("close", at("2026-11-30T15:00:00Z"), venue("US"))).toBe(at("2026-11-30T21:00:00Z")); // a normal day: 16:00
  });

  it("ends the day at the local midnight of the market", () => {
    expect(nextStop("day", at("2026-10-27T11:00:00Z"), xetra)).toBe(at("2026-10-27T23:00:00Z"));
    expect(nextStop("day", at("2026-10-27T11:00:00Z"), venue("US"))).toBe(at("2026-10-28T04:00:00Z"));
  });
});
