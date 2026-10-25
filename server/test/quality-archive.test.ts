import { describe, expect, it } from "vitest";
import { createArchive } from "../src/data/archive.js";
import type { Bar, MarketData } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";

const DAY = 86400;
const D = 20 * DAY; // an arbitrary UTC day start
const bar = (i: number, c: number, extra: Partial<Bar> = {}): Bar => ({ t: D + 8 * 3600 + i * 60, o: c, h: c + 0.05, l: c - 0.05, c, v: 10, ...extra });
const calm = (n: number): Bar[] => Array.from({ length: n }, (_, i) => bar(i, 100 + (i % 2 ? 0.05 : -0.05)));

function setup(bars: Bar[], opts: { tolerance?: number } = {}) {
  const source: MarketData = { async bars(_s, from, to) { return bars.filter((b) => b.t >= from && b.t < to); } };
  const db = openDb(":memory:");
  const archive = createArchive(db, source, { now: () => D + 3 * DAY, minGapMs: 0, dailyTolerance: () => opts.tolerance ?? 0.005 });
  return { db, archive };
}
const kinds = (db: ReturnType<typeof openDb>) =>
  db.prepare("select t, kind from bar_flags order by t, kind").all() as { t: number; kind: string }[];

describe("flags while storing (#50)", () => {
  it("finds eight artificial errors, one case per check, and nothing else", async () => {
    const bars = calm(99);
    bars[10] = { ...bars[10], h: 99 }; // high under the body
    bars[20] = { ...bars[20], l: 105 }; // low over the body
    bars[30] = { ...bars[30], o: 0, l: 0 }; // price of 0
    bars[40] = bar(40, 1, { o: 100, h: 100.1 }); // close at 1/100, back the next minute
    bars[50] = bar(50, 1000, { o: 100, l: 99.9 }); // ten-fold tick
    bars.push(bar(100, 100), bar(100, 100.2)); // a minute twice
    bars.push(bar(99, 100)); // and one back in time
    const { db, archive } = setup(bars);
    await archive.fetchDay("A", D);
    db.prepare("insert into daily_bars (symbol, day, o, h, l, c, v) values ('A', ?, 1, 1, 1, 90, 1)").run(new Date(D * 1000).toISOString().slice(0, 10));
    archive.recheck("A", D, D + DAY);
    const found = kinds(db).map((f) => `${(f.t - D - 8 * 3600) / 60}:${f.kind}`);
    expect(found).toEqual(["10:struct", "20:struct", "30:struct", "40:spike", "50:spike", "99:time", "100:daily", "100:dup"].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b)));
  });

  it("does not store a structurally broken bar, but notes it", async () => {
    const bars = calm(10);
    bars[4] = { ...bars[4], h: 50 };
    const { db, archive } = setup(bars);
    expect(await archive.fetchDay("A", D)).toBe(9);
    expect(archive.barsBetween("A", D, D + DAY).map((b) => b.t)).not.toContain(bars[4].t);
    expect(kinds(db)).toEqual([{ t: bars[4].t, kind: "struct" }]);
  });

  it("marks a spike but keeps the bar, and the simulation price skips it", async () => {
    const bars = calm(40);
    bars[20] = bar(20, 1000, { o: 100, l: 99.9 });
    const { archive } = setup(bars);
    await archive.fetchDay("A", D);
    expect(archive.barsBetween("A", D, D + DAY)).toHaveLength(40);
    const after = bars[20].t + 60; // the moment bar 20 is over
    expect(archive.lastCompleteBar("A", after)!.c).toBe(1000);
    expect(archive.lastCompleteBar("A", after, { skipFlagged: true })!.t).toBe(bars[19].t);
  });

  it("does not flag a real jump that stays (earnings gap like NVDA)", async () => {
    const bars = [...calm(40), ...calm(40).map((b, i) => ({ ...b, t: bars0(40 + i), o: b.o * 1.13, h: b.h * 1.13, l: b.l * 1.13, c: b.c * 1.13 }))];
    function bars0(i: number) { return D + 8 * 3600 + i * 60; }
    const { db, archive } = setup(bars);
    await archive.fetchDay("A", D);
    expect(kinds(db)).toEqual([]);
  });

  it("replaces its spike flags on a new check and leaves the others", async () => {
    const bars = calm(40);
    bars[20] = bar(20, 1000, { o: 100, l: 99.9 });
    bars.push(bars[5]);
    const { db, archive } = setup(bars);
    await archive.fetchDay("A", D);
    db.prepare("insert into bar_flags values ('A', ?, 'spike', 'stale')").run(bars[3].t);
    const r = archive.recheck("A", D, D + DAY);
    expect(r).toMatchObject({ bars: 40, spike: 1 });
    expect(kinds(db).map((f) => f.kind).sort()).toEqual(["dup", "spike"]);
  });

  it("compares the last minute of a finished day with the daily close", async () => {
    const { db, archive } = setup(calm(30));
    await archive.fetchDay("A", D);
    const day = new Date(D * 1000).toISOString().slice(0, 10);
    db.prepare("insert into daily_bars values ('A', ?, 1, 1, 1, 100, 1)").run(day);
    expect(archive.recheck("A", D, D + DAY).daily).toBe(0); // 99.95 against 100: 0,05 %
    db.prepare("update daily_bars set c = 98").run();
    expect(archive.recheck("A", D, D + DAY).daily).toBe(1);
    expect(archive.flagsBetween("A", D, D + DAY, ["daily"])[0].detail).toMatch(/Tagesschluss 98/);
  });

  it("checks 30 days of 19 series in well under 10 s", async () => {
    const db = openDb(":memory:");
    const insert = db.prepare("insert into bars values (?, ?, 100, 100.1, 99.9, 100, 5)");
    db.transaction(() => {
      for (let s = 0; s < 19; s++) for (let d = 0; d < 30; d++) for (let i = 0; i < 510; i++) insert.run(`S${s}`, D + d * DAY + 8 * 3600 + i * 60, );
    })();
    const archive = createArchive(db, { async bars() { return []; } }, { now: () => D + 40 * DAY, minGapMs: 0 });
    const t0 = performance.now();
    for (let s = 0; s < 19; s++) archive.recheck(`S${s}`, D, D + 30 * DAY);
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 30_000); // filling 290,000 bars (and their indexes) is part of the test and slows under load; only the check is timed
});
