import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createArchive } from "../src/data/archive.js";
import type { Bar, MarketData } from "../src/data/marketdata.js";
import { OPEN_WINDOW_S, advance, skipClosed } from "../src/domain/clock.js";

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
