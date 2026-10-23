import { describe, expect, it } from "vitest";
import { readSettings } from "../src/config.js";

const defaults = { liveDelayS: 900, catchUpTempo: 300, liveRefreshS: 60 };

describe("readSettings", () => {
  it("has the defaults when nothing is set", () => {
    expect(readSettings({})).toEqual(defaults);
  });

  it("reads positive numbers", () => {
    expect(readSettings({ LIVE_DELAY_S: "600", CATCH_UP_TEMPO: "120", LIVE_REFRESH_S: "30" })).toEqual({
      liveDelayS: 600, catchUpTempo: 120, liveRefreshS: 30,
    });
  });

  it.each(["abc", "-5", "0", "", "NaN", "Infinity"])("falls back to the default for %j instead of breaking the clock", (bad) => {
    expect(readSettings({ LIVE_DELAY_S: bad, CATCH_UP_TEMPO: bad, LIVE_REFRESH_S: bad })).toEqual(defaults);
  });
});
