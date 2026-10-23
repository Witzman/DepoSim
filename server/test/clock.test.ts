import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createArchive } from "../src/data/archive.js";
import type { Bar, MarketData } from "../src/data/marketdata.js";
import {
  CATCH_UP_LAG_S, LIVE_EDGE_S, LIVE_MARGIN_S, OPEN_WINDOW_S, advance, advanceCarry, effectiveTempo, liveLimit, skipClosed,
} from "../src/domain/clock.js";

const bar = (t: number): Bar => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });

async function archiveWith(bars: Record<string, number[]>) {
  const source: MarketData = {
    async bars(symbol, fromT, toT) {
      return (bars[symbol] ?? []).filter((t) => t >= fromT && t < toT).map(bar);
    },
  };
  const archive = createArchive(openDb(":memory:"), source, { now: () => 10 ** 9, minGapMs: 0 });
  // The test timestamps span two UTC days: 0..86399 and 86400..172799.
  for (const symbol of Object.keys(bars)) for (const day of [0, 86400]) await archive.ensureDay(symbol, day);
  return archive;
}

describe("advance", () => {
  it("moves the simulation time by tempo times the real time", () => {
    expect(advance(1000, 60, 250)).toBe(1015);
    expect(advance(1000, 5, 1000)).toBe(1005);
  });

  it("rounds down to whole seconds", () => {
    expect(advance(1000, 1, 250)).toBe(1000);
    expect(advance(1000, 30, 100)).toBe(1003);
  });
});

describe("skipClosed", () => {
  // Friday session, then a long gap, then the Monday session.
  const bars = { A: [1000, 1060, 1120, 100000, 100060], B: [1000, 1180, 100120] };

  it("leaves the time alone while some instrument had a bar within the open window", async () => {
    const archive = await archiveWith(bars);
    expect(skipClosed(1200, ["A", "B"], archive)).toBe(1200);
    // B has the newest bar (1180), complete at 1240. Exactly OPEN_WINDOW_S later it still counts ...
    expect(skipClosed(1240 + OPEN_WINDOW_S, ["A", "B"], archive)).toBe(1240 + OPEN_WINDOW_S);
    // ... and one second later it does not.
    expect(skipClosed(1240 + OPEN_WINDOW_S + 1, ["A", "B"], archive)).toBe(100000 + 60);
  });

  it("jumps over a gap to the moment the first bar after it is complete", async () => {
    const archive = await archiveWith(bars);
    expect(skipClosed(2000, ["A", "B"], archive)).toBe(100000 + 60);
    expect(skipClosed(5000, ["A", "B"], archive)).toBe(100000 + 60);
  });

  it("does not jump when one thin instrument is quiet but another still trades", async () => {
    const archive = await archiveWith({ A: [1000, 1060, 1120, 1180, 1240], B: [1000] });
    expect(skipClosed(1300, ["A", "B"], archive)).toBe(1300);
  });

  it("only looks at the instruments it is given, so a round-the-clock series is left out", async () => {
    const archive = await archiveWith({ A: [1000], FX: [1000, 1060, 1120, 1180, 1240, 1300, 1360, 1420, 1480, 1540, 1600] });
    expect(skipClosed(1600, ["A"], archive)).toBeUndefined();
    expect(skipClosed(1600, ["A", "FX"], archive)).toBe(1600);
  });

  it("is undefined at the end of the data", async () => {
    const archive = await archiveWith(bars);
    expect(skipClosed(200000, ["A", "B"], archive)).toBeUndefined();
    expect(skipClosed(5000, [], archive)).toBeUndefined();
  });

  it("jumps from before the first bar of the data", async () => {
    const archive = await archiveWith(bars);
    expect(skipClosed(10, ["A", "B"], archive)).toBe(1000 + 60);
  });
});

describe("liveLimit", () => {
  it("is now minus the delay, in whole seconds", () => {
    expect(liveLimit(1000, 900)).toBe(100);
    expect(liveLimit(1000.9, 900)).toBe(100);
  });
});

describe("effectiveTempo", () => {
  it("is the chosen tempo for a replay, however far behind", () => {
    expect(effectiveTempo(false, 30, 99999, 300)).toBe(30);
  });

  it("is the catch-up tempo for a live simulation that is more than the threshold behind, and real time otherwise", () => {
    expect(CATCH_UP_LAG_S).toBe(120);
    expect(effectiveTempo(true, 30, 121, 300)).toBe(300);
    expect(effectiveTempo(true, 30, 120, 300)).toBe(1);
    expect(effectiveTempo(true, 60, 0, 300)).toBe(1);
  });

  it("keeps the constants the spec names", () => {
    expect(LIVE_EDGE_S).toBe(1800);
    expect(LIVE_MARGIN_S).toBe(60);
  });
});

describe("advance with a wide tempo", () => {
  it("takes a tempo that is not one of the buttons", () => {
    expect(advance(1000, 300, 250)).toBe(1075);
  });
});

describe("advanceCarry", () => {
  it("carries the part of a second that a short tick leaves over", () => {
    expect(advanceCarry(1000, 1, 250, 0)).toEqual({ s: 1000, carry: 0.25 });
    let s = 1000;
    let carry = 0;
    for (let i = 0; i < 4; i++) ({ s, carry } = advanceCarry(s, 1, 250, carry));
    expect(s).toBe(1001);
    expect(carry).toBe(0);
  });

  it("keeps tempo 5 and 30 exact over eight ticks of 250 ms (2 s of real time)", () => {
    for (const [tempo, expected] of [[5, 10], [30, 60], [60, 120]] as const) {
      let s = 1000;
      let carry = 0;
      for (let i = 0; i < 8; i++) ({ s, carry } = advanceCarry(s, tempo, 250, carry));
      expect(s - 1000).toBe(expected);
    }
  });

  it("leaves nothing over when the tick is a whole number of simulated seconds", () => {
    expect(advanceCarry(1000, 60, 250, 0)).toEqual({ s: 1015, carry: 0 });
  });
});
