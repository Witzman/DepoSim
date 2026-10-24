import { describe, expect, it } from "vitest";
import { defaultPrefs, parsePrefs, toConfig } from "../src/indicatorPrefs.js";

describe("indicator prefs", () => {
  it("falls back to defaults for garbage", () => {
    expect(parsePrefs(null)).toEqual(defaultPrefs());
    expect(parsePrefs("{nope")).toEqual(defaultPrefs());
    expect(parsePrefs('{"enabled":"x","params":5}')).toEqual(defaultPrefs());
  });
  it("keeps valid choices, drops unknown ids and bad numbers", () => {
    const p = parsePrefs('{"enabled":["rsi","bogus","sma"],"params":{"rsi":{"period":9},"sma":{"period":-3}}}');
    expect(p.enabled).toEqual(["sma", "rsi"]);
    expect(p.params.rsi.period).toBe(9);
    expect(p.params.sma.period).toBe(20);
  });
  it("only enabled indicators reach the config", () => {
    expect(toConfig({ ...defaultPrefs(), enabled: ["macd"] })).toEqual({ macd: { fast: 12, slow: 26, signal: 9 } });
  });
});
