import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createArchive } from "../src/data/archive.js";
import { MarketDataError, type Bar, type MarketData } from "../src/data/marketdata.js";

const DAY = 86400;
const bar = (t: number, c = 100): Bar => ({ t, o: c, h: c, l: c, c, v: 1 });

/** A source that serves the given bars and records every call. */
function fakeSource(all: Record<string, Bar[]>) {
  const calls: { symbol: string; fromT: number; toT: number; at: number }[] = [];
  const source: MarketData = {
    async bars(symbol, fromT, toT) {
      calls.push({ symbol, fromT, toT, at: performance.now() });
      return (all[symbol] ?? []).filter((b) => b.t >= fromT && b.t < toT);
    },
  };
  return { source, calls };
}

describe("openDb", () => {
  it("creates the tables, with foreign keys on", () => {
    const db = openDb(":memory:");
    const names = db.prepare("select name from sqlite_master where type = 'table'").all().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(["bars", "fetched_days"]));
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("archive.ensureDay", () => {
  const long = { now: () => 10 * DAY };

  it("asks the source once per symbol and day, then answers from the archive", async () => {
    const { source, calls } = fakeSource({ A: [bar(1000), bar(1060)] });
    const archive = createArchive(openDb(":memory:"), source, { ...long, minGapMs: 0 });
    await archive.ensureDay("A", 0);
    await archive.ensureDay("A", 0);
    expect(calls).toHaveLength(1);
    expect(archive.barsBetween("A", 0, DAY).map((b) => b.t)).toEqual([1000, 1060]);
  });

  it("fetches a different day and a different symbol separately", async () => {
    const { source, calls } = fakeSource({ A: [bar(1000)], B: [bar(DAY + 5)] });
    const archive = createArchive(openDb(":memory:"), source, { ...long, minGapMs: 0 });
    await archive.ensureDay("A", 0);
    await archive.ensureDay("A", DAY);
    await archive.ensureDay("B", 0);
    expect(calls).toHaveLength(3);
  });

  it("asks only once when the same day is requested twice at the same time", async () => {
    const { source, calls } = fakeSource({ A: [bar(1000)] });
    const archive = createArchive(openDb(":memory:"), source, { ...long, minGapMs: 0 });
    await Promise.all([archive.ensureDay("A", 0), archive.ensureDay("A", 0)]);
    expect(calls).toHaveLength(1);
  });

  it("reloads a day whose end is still in the future and adds only new bars", async () => {
    let now = DAY / 2;
    const all: Record<string, Bar[]> = { A: [bar(1000)] };
    const { source, calls } = fakeSource(all);
    const archive = createArchive(openDb(":memory:"), source, { now: () => now, minGapMs: 0 });
    await archive.ensureDay("A", 0);
    all.A.push(bar(1060));
    await archive.ensureDay("A", 0);
    expect(calls).toHaveLength(2);
    expect(archive.barsBetween("A", 0, DAY).map((b) => b.t)).toEqual([1000, 1060]);
    now = DAY + 1;
    await archive.ensureDay("A", 0);
    await archive.ensureDay("A", 0);
    expect(calls).toHaveLength(3);
  });

  it("marks nothing as fetched when the source fails, so the next call tries again", async () => {
    let fail = true;
    const calls: number[] = [];
    const source: MarketData = {
      async bars() {
        calls.push(1);
        if (fail) throw new MarketDataError("rate_limited", "429");
        return [bar(1000)];
      },
    };
    const archive = createArchive(openDb(":memory:"), source, { ...long, minGapMs: 0 });
    await expect(archive.ensureDay("A", 0)).rejects.toMatchObject({ kind: "rate_limited" });
    fail = false;
    await archive.ensureDay("A", 0);
    expect(calls).toHaveLength(2);
    expect(archive.barsBetween("A", 0, DAY)).toHaveLength(1);
  });

  it("calls the source one at a time with at least minGapMs between calls", async () => {
    const { source, calls } = fakeSource({ A: [bar(1)], B: [bar(1)], C: [bar(1)] });
    const archive = createArchive(openDb(":memory:"), source, { ...long, minGapMs: 40 });
    await Promise.all([archive.ensureDay("A", 0), archive.ensureDay("B", 0), archive.ensureDay("C", 0)]);
    expect(calls).toHaveLength(3);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(35);
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(35);
  });
});

describe("archive.ensureDay, a day the source says has no data", () => {
  const noData: MarketData = { async bars() { calls++; throw new MarketDataError("no_data", "holiday"); } };
  let calls = 0;

  it("is an empty day that is marked fetched, and is not asked again once it is over", async () => {
    calls = 0;
    const archive = createArchive(openDb(":memory:"), noData, { now: () => 10 * DAY, minGapMs: 0 });
    await archive.ensureDay("A", 0);
    await archive.ensureDay("A", 0);
    expect(calls).toBe(1);
    expect(archive.barsBetween("A", 0, DAY)).toEqual([]);
  });

  it("is not final while the day is not over, because trading may start later", async () => {
    calls = 0;
    const archive = createArchive(openDb(":memory:"), noData, { now: () => DAY / 2, minGapMs: 0 });
    await archive.ensureDay("A", 0);
    await archive.ensureDay("A", 0);
    expect(calls).toBe(2);
  });
});

describe("archive.ensureDay, a bar whose minute is not over", () => {
  it("is not stored, and is stored with its final values once the minute is over", async () => {
    let now = 1030; // the bar at t = 1000 ends at 1060
    const all: Record<string, Bar[]> = { A: [bar(1000, 5)] };
    const archive = createArchive(openDb(":memory:"), fakeSource(all).source, { now: () => now, minGapMs: 0 });
    await archive.ensureDay("A", 0);
    expect(archive.barsBetween("A", 0, DAY)).toEqual([]);

    all.A = [bar(1000, 7)]; // the source now has the finished minute
    now = 1061;
    await archive.ensureDay("A", 0);
    expect(archive.barsBetween("A", 0, DAY)).toEqual([bar(1000, 7)]);
  });

  it("keeps every bar of a day that is over", async () => {
    const all: Record<string, Bar[]> = { A: [bar(DAY - 60, 5)] }; // the last minute of the day ends exactly at the end
    const archive = createArchive(openDb(":memory:"), fakeSource(all).source, { now: () => DAY, minGapMs: 0 });
    await archive.ensureDay("A", 0);
    expect(archive.barsBetween("A", 0, DAY)).toHaveLength(1);
  });
});

describe("archive lookups", () => {
  async function seeded() {
    const { source } = fakeSource({ A: [bar(1000, 10), bar(1060, 11), bar(1300, 12)] });
    const archive = createArchive(openDb(":memory:"), source, { now: () => 10 * DAY, minGapMs: 0 });
    await archive.ensureDay("A", 0);
    return archive;
  }

  it("a bar is complete only once its minute is over", async () => {
    const archive = await seeded();
    expect(archive.lastCompleteBar("A", 1059)).toBeUndefined();
    expect(archive.lastCompleteBar("A", 1060)?.t).toBe(1000);
    expect(archive.lastCompleteBar("A", 1119)?.t).toBe(1000);
    expect(archive.lastCompleteBar("A", 1120)?.t).toBe(1060);
  });

  it("the last complete bar is still the last one after a long gap", async () => {
    const archive = await seeded();
    expect(archive.lastCompleteBar("A", 1299)?.t).toBe(1060);
  });

  it("nextBarAfter skips gaps and is strictly after", async () => {
    const archive = await seeded();
    expect(archive.nextBarAfter("A", 999)?.t).toBe(1000);
    expect(archive.nextBarAfter("A", 1000)?.t).toBe(1060);
    expect(archive.nextBarAfter("A", 1061)?.t).toBe(1300);
    expect(archive.nextBarAfter("A", 1300)).toBeUndefined();
  });

  it("barsBetween is half open, [from, to)", async () => {
    const archive = await seeded();
    expect(archive.barsBetween("A", 1000, 1300).map((b) => b.t)).toEqual([1000, 1060]);
  });

  it("barsBefore returns the newest complete bars, oldest first", async () => {
    const archive = await seeded();
    expect(archive.barsBefore("A", 1300, 2).map((b) => b.t)).toEqual([1000, 1060]);
    expect(archive.barsBefore("A", 1300, 1).map((b) => b.t)).toEqual([1060]);
    expect(archive.barsBefore("A", 1060, 5).map((b) => b.t)).toEqual([1000]);
    expect(archive.barsBefore("A", 1059, 5)).toEqual([]);
    expect(archive.barsBefore("Z", 5000, 5)).toEqual([]);
  });

  it("an unknown symbol has no bars", async () => {
    const archive = await seeded();
    expect(archive.lastCompleteBar("Z", 5000)).toBeUndefined();
    expect(archive.nextBarAfter("Z", 0)).toBeUndefined();
    expect(archive.barsBetween("Z", 0, DAY)).toEqual([]);
  });
});
