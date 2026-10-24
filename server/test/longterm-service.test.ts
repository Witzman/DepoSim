import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { type DailyData, type DailySeries, MarketDataError } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";
import { LONGTERM_DEPOTS, lastFinishedWeekday } from "../src/longterm.js";
import { D0, DAY } from "./fakes.js";

// Fri 2026-10-23 is the last finished weekday when "now" is Sat 2026-10-24 12:00 UTC.
const SAT = D0 + 2 * DAY + 12 * 3600;
const MON = D0 + 4 * DAY + 12 * 3600; // Mon 2026-10-26

const open: FastifyInstance[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** Five weekdays from 2026-10-19, 10 EUR to 14 EUR at the open, one dividend of 0.50 on the 21st. */
function series(opts: { lastDay?: string; split?: boolean } = {}): DailySeries {
  const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"].filter((d) => d <= (opts.lastDay ?? "9"));
  return {
    bars: days.map((day, i) => ({ day, o: 10 + i, h: 15, l: 9, c: 10.5 + i, v: 1 })),
    dividends: [{ exDay: "2026-10-21", amount: 0.5 }],
    splits: opts.split ? [{ day: "2026-10-20", numerator: 2, denominator: 1 }] : [],
  };
}

function make(opts: { now?: () => number; fail?: (n: number) => MarketDataError | undefined; data?: DailySeries; dbPath?: string; gate?: Promise<void> } = {}) {
  const calls: string[] = [];
  const dailyData: DailyData = {
    async daily(symbol) {
      calls.push(symbol);
      await opts.gate;
      const err = opts.fail?.(calls.length);
      if (err) throw err;
      return opts.data ?? series();
    },
  };
  const app = buildApp({ dbPath: opts.dbPath ?? ":memory:", dailyData, now: opts.now ?? (() => SAT), minGapMs: 0, tickMs: 20 });
  open.push(app);
  return { app, calls };
}

const refresh = async (app: FastifyInstance) => {
  const res = await app.inject({ method: "POST", url: "/api/longterm/refresh" });
  return res;
};
const settle = async (app: FastifyInstance) => {
  // The job runs in the background; poll like the page does.
  for (let i = 0; i < 100; i++) {
    const s = (await app.inject({ url: "/api/longterm/refresh" })).json();
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job did not finish");
};

describe("lastFinishedWeekday", () => {
  it("is the last weekday that is over, in UTC", () => {
    expect(lastFinishedWeekday(SAT)).toBe("2026-10-23");
    expect(lastFinishedWeekday(MON)).toBe("2026-10-23");
    expect(lastFinishedWeekday(MON + DAY)).toBe("2026-10-26");
  });
});

describe("GET /api/longterm", () => {
  it("says what is missing before anything was fetched", async () => {
    const { app } = make();
    const body = (await app.inject({ url: "/api/longterm" })).json();
    expect(body.ready).toBe(false);
    expect(body.missing.map((m: { symbol: string }) => m.symbol)).toEqual(LONGTERM_DEPOTS.map((d) => d.symbol));
  });

  it("computes from stored data after a refresh: three depots, totals and a curve", async () => {
    const { app, calls } = make();
    expect((await refresh(app)).statusCode).toBe(202);
    const job = await settle(app);
    expect(job.items.map((i: { status: string }) => i.status)).toEqual(["loaded", "loaded", "loaded"]);
    expect(calls).toEqual(LONGTERM_DEPOTS.map((d) => d.symbol));

    const body = (await app.inject({ url: "/api/longterm" })).json();
    expect(body.ready).toBe(true);
    expect(body.startCash).toBe(4_000_000);
    expect(body.depots).toHaveLength(3);
    const d = body.depots[0];
    expect(d.curve).toHaveLength(5);
    expect(d.curve[0][0]).toBe("2026-10-19");
    expect(d.totals.shares).toBeGreaterThan(0);
    expect(d.totals.dividendsReceived).toBeGreaterThan(0);
    expect(d.totals.reinvestments).toBe(1);
    expect(d.curve[4][1]).toBe(d.totals.finalValue);
  });

  it("does not fetch again while the data is current, and does when a newer finished day exists", async () => {
    let now = SAT;
    const { app, calls } = make({ now: () => now });
    await refresh(app);
    await settle(app);
    expect(calls).toHaveLength(3);

    await refresh(app); // Saturday again: the newest stored day is the last finished weekday
    const again = await settle(app);
    expect(again.items.map((i: { status: string }) => i.status)).toEqual(["current", "current", "current"]);
    expect(calls).toHaveLength(3);

    now = MON + DAY; // Tuesday: Monday is over and not stored
    await refresh(app);
    await settle(app);
    expect(calls).toHaveLength(6);
  });

  it("answers 409 while a job runs", async () => {
    let release!: () => void;
    const { app } = make({ gate: new Promise<void>((r) => (release = r)) });
    const first = await refresh(app);
    const second = await refresh(app);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain("läuft bereits");
    release();
    await settle(app);
  });

  it("stops at the first 429, reports the rest as skipped and computes nothing", async () => {
    const { app, calls } = make({ fail: (n) => (n === 2 ? new MarketDataError("rate_limited", "429") : undefined) });
    await refresh(app);
    const job = await settle(app);
    expect(job.items.map((i: { status: string }) => i.status)).toEqual(["loaded", "error", "skipped"]);
    expect(job.stoppedByRateLimit).toBe(true);
    expect(calls).toHaveLength(2);
    const body = (await app.inject({ url: "/api/longterm" })).json();
    expect(body.ready).toBe(false);
    expect(body.missing.map((m: { symbol: string }) => m.symbol)).toEqual([LONGTERM_DEPOTS[1].symbol, LONGTERM_DEPOTS[2].symbol]);
  });

  it("refuses to compute over a split instead of guessing", async () => {
    const { app } = make({ data: series({ split: true }) });
    await refresh(app);
    await settle(app);
    const body = (await app.inject({ url: "/api/longterm" })).json();
    expect(body.ready).toBe(false);
    expect(body.missing[0].reason).toContain("Aktiensplit");
  });

  it("opens a database made before the long-term tables and adds them without touching the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "deposim-old-"));
    try {
      const path = join(dir, "old.sqlite");
      const old = new Database(path);
      old.exec(`create table bars (symbol text not null, t integer not null, o real not null, h real not null, l real not null,
        c real not null, v integer not null, primary key (symbol, t));
        insert into bars values ('SAP.DE', 60, 1, 2, 0.5, 1.5, 3);`);
      old.close();
      const db = openDb(path);
      expect(db.prepare("select count(*) as n from bars").get()).toEqual({ n: 1 });
      expect(db.prepare("select count(*) as n from daily_bars").get()).toEqual({ n: 0 });
      expect(db.prepare("select count(*) as n from dividends").get()).toEqual({ n: 0 });
      expect(db.prepare("select count(*) as n from daily_fetched").get()).toEqual({ n: 0 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
