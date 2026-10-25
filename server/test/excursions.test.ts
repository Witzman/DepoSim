import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data/marketdata.js";
import { type ExcursionBars, holdingExcursion, openExcursion, summarize, tradeExcursion } from "../src/domain/excursions.js";
import type { JournalTrade } from "../src/domain/journal.js";

const DAY = 86400;
const H = 3600;
const D0 = 1792627200; // 2026-10-22 00:00 UTC
const T0 = D0 + 10 * H;

const bar = (t: number, h: number, l: number, c: number): Bar => ({ t, o: c, h, l, c, v: 1 });

function access(table: Record<string, Bar[]>, barSeconds = 60): ExcursionBars & { asked: [number, number][] } {
  const asked: [number, number][] = [];
  return {
    asked, barSeconds,
    lastCompleteBar: (symbol, s) => (table[symbol] ?? []).filter((b) => b.t + barSeconds <= s).at(-1),
    nextBarAfter: (symbol, t) => (table[symbol] ?? []).find((b) => b.t > t),
    barsBetween: (symbol, from, to) => { asked.push([from, to]); return (table[symbol] ?? []).filter((b) => b.t >= from && b.t < to); },
  };
}

const SAP = [bar(T0, 103, 97, 101), bar(T0 + 60, 110, 99, 108), bar(T0 + 120, 108, 104, 105)];
const base = { symbol: "SAP.DE", buyPrice: 100, exitPrice: 105, openedSim: T0, endSim: T0 + 180, cost: 10000, s: T0 + 10 * H, benchmark: null };

describe("holdingExcursion", () => {
  it("works out MAE, MFE and the efficiency by hand: low 97, high 110, exit 105", () => {
    const e = holdingExcursion({ ...base, bars: access({ "SAP.DE": SAP }) });
    expect(e).toMatchObject({ maePct: 3, mfePct: 10, maeCents: 300, mfeCents: 1000, efficiency: 0.5, bars: 3 });
  });

  it("a trade that never went under the buy price has MAE 0", () => {
    const up = [bar(T0, 103, 100, 102), bar(T0 + 60, 106, 101, 105)];
    const e = holdingExcursion({ ...base, endSim: T0 + 120, bars: access({ "SAP.DE": up }) });
    expect(e.maePct).toBe(0);
    expect(e.mfePct).toBe(6);
  });

  it("a trade without movement has no efficiency, as there was no gain to take", () => {
    const flat = [bar(T0, 100, 100, 100), bar(T0 + 60, 100, 100, 100)];
    const e = holdingExcursion({ ...base, exitPrice: 100, endSim: T0 + 120, bars: access({ "SAP.DE": flat }) });
    expect(e).toMatchObject({ maePct: 0, mfePct: 0, efficiency: null, bars: 2 });
  });

  it("without any bar there is no figure, only the path of buy and exit", () => {
    const e = holdingExcursion({ ...base, bars: access({}) });
    expect(e).toMatchObject({ maePct: null, mfePct: null, maeCents: null, efficiency: null, bars: 0, path: [100, 105] });
  });

  it("a loss: the efficiency is negative when the exit is under the buy price, the exit counts in MAE", () => {
    const e = holdingExcursion({ ...base, exitPrice: 95, bars: access({ "SAP.DE": SAP }) });
    expect(e.efficiency).toBe(-0.5);
    expect(e.maePct).toBe(5); // the sale at 95 was lower than any bar low
  });

  it("reads no bar that is not over at the exit and none after the simulation time", () => {
    const more = [...SAP, bar(T0 + 180, 200, 50, 100)]; // starts as the sale happens
    const a = access({ "SAP.DE": more });
    const e = holdingExcursion({ ...base, bars: a });
    expect(e.mfePct).toBe(10);
    expect(e.maePct).toBe(3);
    // an open stretch cut off by the clock: the third bar is not over at s
    const cut = holdingExcursion({ ...base, endSim: T0 + 10 * H, s: T0 + 120, bars: access({ "SAP.DE": SAP }) });
    expect(cut.bars).toBe(2);
    expect(Math.max(...a.asked.map(([, to]) => to))).toBeLessThanOrEqual(T0 + 10 * H);
  });

  it("puts the entry in the range of its day, but only once the day is over", () => {
    const day = [bar(D0 + 9 * H, 100, 90, 95), ...SAP]; // day low 90, high 110
    const done = holdingExcursion({ ...base, bars: access({ "SAP.DE": day }), s: D0 + DAY });
    expect(done.entryPosition).toBe(0.5);
    const running = holdingExcursion({ ...base, bars: access({ "SAP.DE": day }), s: T0 + 600 });
    expect(running.entryPosition).toBeNull();
  });

  it("compares with the same money in the benchmark over the same time, and says nothing when a price is missing", () => {
    const table = { "SAP.DE": SAP, BENCH: [bar(T0 - 60, 200, 200, 200), bar(T0 + 120, 204, 204, 204)] };
    const e = holdingExcursion({ ...base, benchmark: "BENCH", bars: access(table) });
    // benchmark 200 -> 204 (+2 %) on 10000 cents = 200; own +5 % = 500
    expect(e.benchmark).toEqual({ symbol: "BENCH", pnl: 200, diff: 300 });
    expect(holdingExcursion({ ...base, benchmark: "NONE", bars: access(table) }).benchmark).toBeNull();
    expect(holdingExcursion({ ...base, bars: access(table) }).benchmark).toBeNull();
  });

  it("samples a long path down", () => {
    const long = Array.from({ length: 500 }, (_, i) => bar(T0 + i * 60, 101, 99, 100));
    const e = holdingExcursion({ ...base, endSim: T0 + 500 * 60, bars: access({ "SAP.DE": long }) });
    expect(e.path).toHaveLength(40);
    expect(e.path[0]).toBe(100);
    expect(e.path.at(-1)).toBe(105);
  });

  it("works on daily bars", () => {
    const days = [bar(D0, 110, 95, 100), bar(D0 + DAY, 120, 100, 118), bar(D0 + 2 * DAY, 130, 90, 90)];
    const e = holdingExcursion({
      ...base, openedSim: D0, endSim: D0 + 2 * DAY, exitPrice: 118, buyPrice: 100, s: D0 + 5 * DAY,
      bars: access({ "SAP.DE": days }, DAY),
    });
    // the third day starts as the sale happens at its open: it is not held through
    expect(e).toMatchObject({ maePct: 5, mfePct: 20, bars: 2 });
    expect(e.efficiency).toBe(0.9);
  });
});

describe("tradeExcursion and openExcursion", () => {
  it("reads a closed trade", () => {
    const t = { symbol: "SAP.DE", buyPrice: 100, sellPrice: 105, openedSim: T0, closedSim: T0 + 180, buyCost: 10000 } as JournalTrade;
    expect(tradeExcursion(t, T0 + H, access({ "SAP.DE": SAP }), null)).toMatchObject({ maePct: 3, mfePct: 10 });
  });

  it("values an open lot at the last price known and gives none without one", () => {
    const lot = { symbol: "SAP.DE", qty: 1, buyPrice: 100, openedSim: T0, cost: 10000 };
    const e = openExcursion(lot, T0 + 180, access({ "SAP.DE": SAP }), null);
    expect(e).toMatchObject({ maePct: 3, mfePct: 10 });
    expect(e!.path.at(-1)).toBe(105);
    expect(openExcursion({ ...lot, symbol: "X" }, T0 + 180, access({}), null)).toBeNull();
  });
});

describe("summarize", () => {
  it("takes medians and sorts the efficiency into buckets; unmeasured trades are left out", () => {
    const mk = (mae: number | null, mfe: number | null, eff: number | null, diff?: number) => ({
      maePct: mae, mfePct: mfe, efficiency: eff, maeCents: null, mfeCents: null, entryPosition: null, bars: mae === null ? 0 : 1, path: [],
      benchmark: diff === undefined ? null : { symbol: "B", pnl: 0, diff },
    });
    const r = summarize([mk(2, 10, 0.5, 100), mk(4, 20, 0.9, -50), mk(0, 5, -0.2), mk(null, null, null)]);
    expect(r.n).toBe(3);
    expect(r.medianMaePct).toBe(2);
    expect(r.medianMfePct).toBe(10);
    expect(r.medianEfficiency).toBe(0.5);
    expect(r.efficiencyBuckets.map((b) => b.count)).toEqual([1, 0, 0, 1, 1]);
    expect(r.benchmark).toEqual({ n: 2, beat: 1 });
  });

  it("has no median for no trade", () => {
    expect(summarize([])).toMatchObject({ n: 0, medianMaePct: null, medianEfficiency: null });
  });
});
