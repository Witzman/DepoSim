import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FX_SYMBOL } from "../src/config.js";
import { createSourceStats, instrumentMarketData, kindOf } from "../src/data/instrumented.js";
import { type MarketData, MarketDataError } from "../src/data/marketdata.js";
import type { InstrumentSearch } from "../src/data/search.js";
import { type Db, openDb } from "../src/db.js";
import { AAPL, D0, D1, DAY, H, SAP, bar } from "./fakes.js";

describe("healthz", () => {
  it("answers 200 and ok", async () => {
    const app = buildApp({ dbPath: ":memory:" });
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
    expect(res.headers["x-deposim-build"]).toBe("dev"); // no build-time file outside the image
    await app.close();
  });
});

const open: FastifyInstance[] = [];
const folders: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true });
});

const NOW = D1 + 12 * H; // Friday 2026-10-23 12:00 UTC

/** A database file the test fills before the app opens it. */
function fixture(seed: (db: Db) => void) {
  const dir = mkdtempSync(join(tmpdir(), "deposim-health-"));
  folders.push(dir);
  const path = join(dir, "d.sqlite");
  const db = openDb(path);
  seed(db);
  db.close();
  return path;
}

const day = (db: Db, symbol: string, dayStart: number, minutes: number, complete = 1, from = 7 * H) => {
  for (let i = 0; i < minutes; i++) {
    const b = bar(dayStart + from + i * 60, 100);
    db.prepare("insert into bars (symbol, t, o, h, l, c, v) values (?, ?, ?, ?, ?, ?, ?)").run(symbol, b.t, b.o, b.h, b.l, b.c, b.v);
  }
  db.prepare("insert or replace into fetched_days (symbol, day_start, complete) values (?, ?, ?)").run(symbol, dayStart, complete);
};

function make(path: string, extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const app = buildApp({
    dbPath: path, instruments: [SAP, AAPL], now: () => clock.t, minGapMs: 0, jobSettings: { enabled: false, overrides: {} }, ...extra,
  });
  open.push(app);
  return app;
}
const clock = { t: NOW };
const get = async (app: FastifyInstance, url: string) => (await app.inject({ url })).json();

describe("coverage", () => {
  it("agrees with fetched_days and bars; a day that was deleted is a gap", async () => {
    clock.t = NOW;
    const path = fixture((db) => {
      day(db, SAP.symbol, D0, 60); // Thursday 10-22, complete, 60 of 510 minutes
      // Wednesday 10-21 is missing on purpose
      day(db, SAP.symbol, D1, 30, 0); // today, not over
      day(db, AAPL.symbol, D0, 20, 1, 13 * H + 1800);
      day(db, AAPL.symbol, D0 - DAY, 0, 1); // fetched, nothing came back
    });
    const app = make(path);
    const cov = await get(app, "/api/data/coverage?days=5"); // Sun 10-19 .. Thu... up to Fri 10-23
    expect(cov.days).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    const sap = cov.rows.find((r: any) => r.symbol === "SAP.DE");
    const state = (r: any) => r.cells.map((c: any) => c.state);
    expect(state(sap)).toEqual(["never", "never", "never", "complete", "partial"]);
    expect(sap.cells[3]).toMatchObject({ bars: 60, expected: 510, thin: true, today: false });
    expect(sap.cells[4]).toMatchObject({ bars: 30, today: true });
    const aapl = cov.rows.find((r: any) => r.symbol === "AAPL");
    expect(aapl.cells[2]).toMatchObject({ state: "empty", bars: 0, expected: 390 });
    expect(aapl.cells[3]).toMatchObject({ state: "complete", bars: 20 });
    // finished trading days that are gaps: SAP 3 (19,20,21), AAPL 19,20 never + 21 empty
    expect(cov.gapCells).toBeGreaterThanOrEqual(3);
    const fx = cov.rows.find((r: any) => r.symbol === FX_SYMBOL);
    expect(fx.cells[0].state).toBe("never");
  });

  it("marks weekends and holidays as closed with the reason and does not count them as gaps", async () => {
    clock.t = Date.parse("2026-04-07T12:00:00Z") / 1000; // Tuesday after Easter Monday 2026-04-06
    const app = make(fixture(() => {}));
    const cov = await get(app, "/api/data/coverage?days=5"); // Thu 04-03 (Good Friday) .. Tue 04-07
    const sap = cov.rows.find((r: any) => r.symbol === "SAP.DE");
    expect(sap.cells.map((c: any) => [c.day, c.state, c.reason])).toEqual([
      ["2026-04-03", "closed", "Feiertag: Karfreitag"],
      ["2026-04-04", "closed", "Wochenende"],
      ["2026-04-05", "closed", "Wochenende"],
      ["2026-04-06", "closed", "Feiertag: Ostermontag"],
      ["2026-04-07", "never", undefined],
    ]);
    const aapl = cov.rows.find((r: any) => r.symbol === "AAPL");
    expect(aapl.cells[0].state).toBe("closed"); // NYSE shuts on Good Friday as well
    clock.t = NOW;
  });

  it("refuses a request for more than 90 days", async () => {
    const app = make(fixture(() => {}));
    expect((await app.inject({ url: "/api/data/coverage?days=91" })).statusCode).toBe(400);
  });
});

describe("gaps within a day", () => {
  it("lists runs of minutes without a bar, and the day without any bar as one run", async () => {
    clock.t = NOW;
    const path = fixture((db) => {
      day(db, SAP.symbol, D0, 60); // 07:00-07:59 UTC
      db.prepare("delete from bars where symbol = ? and t >= ? and t < ?").run(SAP.symbol, D0 + 7 * H + 600, D0 + 7 * H + 1200); // 07:10-07:19
    });
    const app = make(path);
    const g = await get(app, "/api/data/gaps?symbol=SAP.DE&day=2026-10-22");
    expect(g).toMatchObject({ open: true, windowFrom: D0 + 7 * H, windowTo: D0 + 15.5 * H, expected: 510, bars: 50, missingMinutes: 460 });
    expect(g.gaps).toEqual([
      { from: D0 + 7 * H + 600, to: D0 + 7 * H + 1200, minutes: 10 },
      { from: D0 + 8 * H, to: D0 + 15.5 * H, minutes: 450 },
    ]);
    const none = await get(app, "/api/data/gaps?symbol=SAP.DE&day=2026-10-21");
    expect(none.gaps).toEqual([{ from: D0 - DAY + 7 * H, to: D0 - DAY + 15.5 * H, minutes: 510 }]);
  });

  it("cuts the window at the present and tells thin ETFs apart", async () => {
    clock.t = D1 + 8 * H; // 08:00 UTC, Xetra is open
    const path = fixture((db) => day(db, SAP.symbol, D1, 30, 0));
    const app = make(path, { instruments: [SAP, { symbol: "EXS1.DE", name: "DAX", currency: "EUR", venue: "XETRA", kind: "ETF" }] });
    const g = await get(app, "/api/data/gaps?symbol=SAP.DE&day=2026-10-23");
    expect(g.windowTo).toBe(D1 + 8 * H);
    expect(g.missingMinutes).toBe(30);
    expect(g.hint).not.toContain("Xetra-ETFs");
    expect((await get(app, "/api/data/gaps?symbol=EXS1.DE&day=2026-10-23")).hint).toContain("Xetra-ETFs");
    clock.t = NOW;
  });

  it("says nothing is expected on a closed day, and refuses unknown input", async () => {
    clock.t = NOW;
    const app = make(fixture(() => {}));
    const sat = await get(app, "/api/data/gaps?symbol=SAP.DE&day=2026-10-17");
    expect(sat).toMatchObject({ open: false, reason: "Wochenende", gaps: [] });
    expect((await app.inject({ url: "/api/data/gaps?symbol=NOPE&day=2026-10-17" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/data/gaps?symbol=SAP.DE&day=gestern" })).statusCode).toBe(400);
  });
});

describe("source counters", () => {
  const stats = () => createSourceStats(openDb(":memory:"), () => clock.t);

  it("maps the error kinds to the status they stand for", () => {
    expect(kindOf(new MarketDataError("no_data", "x"))).toBe("404");
    expect(kindOf(new MarketDataError("bad_shape", "x"))).toBe("422");
    expect(kindOf(new MarketDataError("rate_limited", "x"))).toBe("429");
    expect(kindOf(new MarketDataError("network", "x"))).toBe("error");
    expect(kindOf(new Error("boom"))).toBe("error");
  });

  it("counts 200, 404 and 429, times the answer, and passes errors on unchanged", async () => {
    clock.t = NOW;
    const s = stats();
    const inner: MarketData = {
      async bars(symbol) {
        await new Promise((r) => setTimeout(r, 20));
        if (symbol === "OK") return [bar(0, 1)];
        throw new MarketDataError(symbol === "EMPTY" ? "no_data" : "rate_limited", symbol);
      },
    };
    const wrapped = instrumentMarketData(inner, s);
    await wrapped.bars("OK", 0, 60);
    await wrapped.bars("OK", 0, 60);
    await expect(wrapped.bars("EMPTY", 0, 60)).rejects.toThrow("EMPTY");
    await expect(wrapped.bars("SLOW", 0, 60)).rejects.toMatchObject({ kind: "rate_limited" });
    const minute = s.summary().find((x) => x.source === "yahoo-minute")!;
    expect(minute.counts).toEqual({ "200": 2, "404": 1, "422": 0, "429": 1, error: 0 });
    expect(minute.calls).toBe(4);
    expect(minute.meanMs).toBeGreaterThanOrEqual(15);
    expect(minute.lastOkAt).toBe(NOW);
    expect(s.summary().find((x) => x.source === "ecb")).toMatchObject({ calls: 0, meanMs: null, lastOkAt: null });
  });

  it("forgets calls after 24 hours but keeps the time of the last success", async () => {
    clock.t = NOW;
    const s = stats();
    s.record("yahoo-minute", "200", 10);
    s.record("yahoo-minute", "429", 10);
    clock.t = NOW + 23 * H;
    expect(s.summary()[0].counts["429"]).toBe(1);
    clock.t = NOW + 25 * H;
    expect(s.summary()[0]).toMatchObject({ calls: 0, lastOkAt: NOW });
    clock.t = NOW;
  });

  it("the app counts what its archive asks of a fake source, and /api/data/source shows it", async () => {
    clock.t = D1 + 20 * H; // markets shut
    const calls: string[] = [];
    const source: MarketData = {
      async bars(symbol, fromT) {
        calls.push(symbol);
        if (symbol === "AAPL") throw new MarketDataError("rate_limited", "429");
        if (symbol === FX_SYMBOL) throw new MarketDataError("no_data", "404");
        return [bar(fromT + 7 * H, 100)];
      },
    };
    const app = make(fixture(() => {}), { marketData: source });
    await app.inject({ method: "POST", url: "/api/archive/backfill", payload: { days: 1 } });
    await app.jobs.settled();
    for (let i = 0; i < 50 && (await get(app, "/api/archive/backfill")).running; i++) await new Promise((r) => setTimeout(r, 20));
    const { sources } = await get(app, "/api/data/source");
    const minute = sources.find((x: any) => x.source === "yahoo-minute");
    expect(minute.counts["200"]).toBeGreaterThan(0);
    expect(minute.counts["429"]).toBe(1); // the first 429 ends the run
    expect(minute.counts["404"] + minute.counts["429"] + minute.counts["200"]).toBe(calls.length);
    // twenty-five hours later the counters are back to zero
    clock.t += 25 * H;
    const later = (await get(app, "/api/data/source")).sources.find((x: any) => x.source === "yahoo-minute");
    expect(later.calls).toBe(0);
    expect(later.lastOkAt).not.toBeNull();
    clock.t = NOW;
  });
});

describe("the light", () => {
  /** SAP and the exchange rate complete on every trading day of the last 29 days. */
  const seedComplete = (db: Db) => {
    for (let i = 0; i < 29; i++) {
      const d = D1 - i * DAY;
      const weekday = new Date(d * 1000).getUTCDay();
      if (weekday !== 6) day(db, FX_SYMBOL, d, 5); // the rate has bars on Sunday evening, none on Saturday
      if (weekday === 0 || weekday === 6) continue;
      day(db, SAP.symbol, d, 5);
      day(db, AAPL.symbol, d, 5, 1, 14 * H);
    }
  };

  it("is green with a complete archive, and yellow when a day is deleted", async () => {
    clock.t = NOW;
    const path = fixture(seedComplete);
    const app = make(path);
    const ok = await get(app, "/api/data/status");
    expect(ok.reasons.filter((r: any) => r.level !== "info")).toEqual([]);
    expect(ok.level).toBe("green");
    const db = openDb(path);
    db.prepare("delete from fetched_days where symbol = 'SAP.DE' and day_start = ?").run(D0);
    db.close();
    const gap = await get(app, "/api/data/status");
    expect(gap.level).toBe("yellow");
    expect(gap.gapCells).toBe(1);
    expect(gap.reasons.map((r: any) => r.text).join()).toContain("nicht vollständig");
  });

  it("turns yellow on a 429 and goes back once it is 24 hours old", async () => {
    clock.t = NOW;
    const limited: InstrumentSearch = { search: async () => { throw new MarketDataError("rate_limited", "x"); } };
    const app = make(fixture(seedComplete), { search: limited });
    await app.inject({ url: "/api/search?q=sap" });
    const s = await get(app, "/api/data/status");
    expect(s).toMatchObject({ level: "yellow", rateLimited24h: 1 });
    expect(s.reasons.map((r: any) => r.text).join()).toContain("429");
    clock.t = NOW + 26 * H;
    // by then the archive has aged too; only the 429 count is under test
    expect((await get(app, "/api/data/status")).rateLimited24h).toBe(0);
    clock.t = NOW;
  });

  it("turns red when the last successful collection is older than two days", async () => {
    clock.t = NOW;
    const path = fixture((db) => {
      seedComplete(db);
      db.prepare("insert into job_runs (job, trigger, slot, started_at, finished_at, status, message, counts) values ('sammlung-xetra', 'plan', ?, ?, ?, 'ok', 'x', '{\"loaded\":1}')")
        .run(NOW - 3 * DAY, NOW - 3 * DAY, NOW - 3 * DAY + 60);
    });
    const app = make(path, { jobSettings: { enabled: true, overrides: {} } });
    const red = await get(app, "/api/data/status");
    expect(red.level).toBe("red");
    expect(red.reasons.find((r: any) => r.level === "red").text).toContain("älter als 2 Tage");
    // a success a day ago: not red any more
    const db = openDb(path);
    db.prepare("insert into job_runs (job, trigger, slot, started_at, finished_at, status, message, counts) values ('sammlung-us', 'plan', ?, ?, ?, 'ok', 'x', '{\"loaded\":1}')")
      .run(NOW - DAY, NOW - DAY, NOW - DAY + 60);
    db.close();
    expect((await get(app, "/api/data/status")).level).not.toBe("red");
  });

  it("does not turn red when the scheduler is off, and says so", async () => {
    clock.t = NOW;
    const app = make(fixture(seedComplete));
    const s = await get(app, "/api/data/status");
    expect(s.level).toBe("green");
    expect(s.reasons).toEqual([expect.objectContaining({ level: "info" })]);
  });

  it("writes an entry to the job log when the light changes, once", async () => {
    clock.t = NOW;
    const path = fixture(seedComplete);
    const app = make(path);
    expect(app.health.checkAlarm()).toBeNull(); // green from the start: nothing to say
    const db = openDb(path);
    db.prepare("delete from fetched_days where symbol = 'SAP.DE' and day_start = ?").run(D0);
    db.close();
    expect(app.health.checkAlarm()).toBe("yellow");
    expect(app.health.checkAlarm()).toBeNull(); // unchanged
    const runs = (await get(app, "/api/jobs")).runs.filter((r: any) => r.job === "ampel");
    expect(runs).toHaveLength(1);
    expect(runs[0].message).toContain("Datenampel gelb");
  });
});

describe("archive size", () => {
  it("counts rows, file size, bars per week and the last backup", async () => {
    clock.t = NOW;
    const app = make(fixture((db) => { day(db, SAP.symbol, D0, 60); day(db, SAP.symbol, D0 - 7 * DAY, 10); }));
    const a = await get(app, "/api/data/archive");
    expect(a.rows).toMatchObject({ bars: 70, fetchedDays: 2 });
    expect(a.fileBytes).toBeGreaterThan(0);
    expect(a.weeks.map((w: any) => w.bars)).toEqual([10, 60]);
    expect(a.weeks[1].weekStart).toBe("2026-10-19"); // a Monday
    expect(a.lastBackupAt).toBeNull();
    expect(a.backupEnabled).toBe(false);
  });
});
