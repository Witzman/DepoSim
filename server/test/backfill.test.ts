import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createArchive } from "../src/data/archive.js";
import { type MarketData, MarketDataError } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";
import { AAPL, D0, D1, DAY, H, SAP, makeSource } from "./fakes.js";

const NOW = D0 + 5 * DAY; // Tuesday 2026-10-27 00:00 UTC, every market is shut

const open: FastifyInstance[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** Wraps the fake source: `onCall(n)` may throw for the n-th call (1-based). */
function make(opts: { now?: number; onCall?: (n: number, symbol: string) => void } = {}) {
  const { source } = makeSource();
  let n = 0;
  const calls: string[] = [];
  const wrapped: MarketData = {
    async bars(symbol, fromT, toT) {
      calls.push(`${symbol}@${fromT}`);
      opts.onCall?.(++n, symbol);
      return source.bars(symbol, fromT, toT);
    },
  };
  const app = buildApp({
    dbPath: ":memory:", marketData: wrapped, instruments: [SAP, AAPL], now: () => opts.now ?? NOW, minGapMs: 0, tickMs: 20,
  });
  open.push(app);
  return { app, calls };
}

const get = (app: FastifyInstance, url: string) => app.inject({ url });
const post = (app: FastifyInstance, body: unknown = {}) =>
  app.inject({ method: "POST", url: "/api/archive/backfill", payload: body as object });
/** Starts a job, waits until it is done and answers like the old blocking call did: the report. */
const backfill = async (app: FastifyInstance, body: unknown = {}) => {
  const res = await post(app, body);
  if (res.statusCode !== 202) return res;
  for (let i = 0; i < 500; i++) {
    const job = (await get(app, "/api/archive/backfill")).json();
    if (!job.running) return { statusCode: 200, json: () => job.report } as { statusCode: number; json: () => any };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("backfill did not finish");
};

describe("archive.missingDays", () => {
  it("lists never fetched and incomplete days, not complete ones", async () => {
    const { source } = makeSource();
    const archive = createArchive(openDb(":memory:"), source, { minGapMs: 0, now: () => D1 + 12 * H });
    await archive.ensureDay(SAP.symbol, D0); // complete: the day is over
    await archive.ensureDay(SAP.symbol, D1); // incomplete: the day is not over
    expect(archive.missingDays([SAP.symbol, AAPL.symbol], D0, D1 + DAY)).toEqual([
      { symbol: SAP.symbol, dayStart: D1, state: "incomplete" },
      { symbol: AAPL.symbol, dayStart: D1, state: "never" },
      { symbol: AAPL.symbol, dayStart: D0, state: "never" },
    ]);
  });

  it("fetchDay says how many bars it stored and fails on a source error", async () => {
    const { source } = makeSource();
    const archive = createArchive(openDb(":memory:"), source, { minGapMs: 0, now: () => D0 + 9 * DAY });
    expect(await archive.fetchDay(SAP.symbol, D0)).toBe(60);
    expect(await archive.fetchDay(SAP.symbol, D0 - DAY)).toBe(0);
    const failing = createArchive(openDb(":memory:"), { bars: async () => { throw new MarketDataError("rate_limited", "x"); } },
      { minGapMs: 0, now: () => D0 + 9 * DAY });
    await expect(failing.fetchDay(SAP.symbol, D0)).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("GET /api/archive/missing", () => {
  it("lists what is missing in the default range, labelled as an assumption", async () => {
    const { app } = make();
    const res = await get(app, "/api/archive/missing");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ days: 7, daysIsAssumption: true, blocked: null });
    expect(body.reachDays).toBeGreaterThan(7);
    // 3 series (SAP, AAPL, exchange rate) x 7 finished days
    expect(body.items).toHaveLength(21);
    expect(body.items[0]).toEqual({ symbol: expect.any(String), day: "2026-10-26", dayStart: NOW - DAY, state: "never", inReach: true });
  });

  it("gives the reason when a backfill would be refused", async () => {
    const { app } = make({ now: D0 + 10 * H }); // Thursday 12:00 Berlin
    const body = (await get(app, "/api/archive/missing")).json();
    expect(body.blocked).toMatch(/Xetra/);
  });

  it("rejects a range that is not a number of days", async () => {
    const { app } = make();
    expect((await get(app, "/api/archive/missing?days=0")).statusCode).toBe(400);
    expect((await get(app, "/api/archive/missing?days=abc")).statusCode).toBe(400);
  });

  it("marks days beyond the reach of the source", async () => {
    const { app } = make();
    const body = (await get(app, "/api/archive/missing?days=40")).json();
    const far = body.items.filter((i: any) => !i.inReach);
    expect(far.length).toBeGreaterThan(0);
    expect(far.every((i: any) => i.dayStart < NOW - body.reachDays * DAY)).toBe(true);
  });
});

describe("POST /api/archive/backfill", () => {
  it("loads sequentially and reports per symbol and day", async () => {
    const { app, calls } = make();
    const res = await backfill(app);
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report).toMatchObject({ days: 7, daysIsAssumption: true, stoppedByRateLimit: false });
    expect(report.counts).toEqual({ loaded: 5, empty: 16, error: 0, skipped: 0, outOfRange: 0 });
    expect(calls).toHaveLength(21);
    const sapD0 = report.items.find((i: any) => i.symbol === "SAP.DE" && i.dayStart === D0);
    expect(sapD0).toEqual({ symbol: "SAP.DE", day: "2026-10-22", dayStart: D0, status: "loaded", label: "geladen", bars: 60 });
    const sapEmpty = report.items.find((i: any) => i.symbol === "SAP.DE" && i.dayStart === D0 - DAY);
    expect(sapEmpty).toMatchObject({ status: "empty", label: "leer", bars: 0 });
    // asked again, nothing is missing any more
    const again = (await backfill(app)).json();
    expect(again.items).toEqual([]);
    expect(calls).toHaveLength(21);
  });

  it("stops at the first 429 and reports the rest as skipped", async () => {
    const { app, calls } = make({ onCall: (n) => { if (n === 4) throw new MarketDataError("rate_limited", "429"); } });
    const report = (await backfill(app)).json();
    expect(calls).toHaveLength(4);
    expect(report.stoppedByRateLimit).toBe(true);
    expect(report.counts.skipped).toBe(21 - 4);
    expect(report.counts.error).toBe(1);
    const statuses = report.items.map((i: any) => i.status);
    expect(statuses.slice(0, 3).every((s: string) => s === "loaded" || s === "empty")).toBe(true);
    expect(statuses[3]).toBe("error");
    expect(statuses.slice(4).every((s: string) => s === "skipped")).toBe(true);
    expect(report.items[3].label).toBe("Fehler");
    expect(report.items[4].label).toBe("übersprungen");
  });

  it("goes on after another error", async () => {
    const { app } = make({ onCall: (n) => { if (n === 2) throw new MarketDataError("network", "down"); } });
    const report = (await backfill(app)).json();
    expect(report.stoppedByRateLimit).toBe(false);
    expect(report.counts.error).toBe(1);
    expect(report.counts.skipped).toBe(0);
  });

  it("reports days beyond the reach without asking the source", async () => {
    const { app, calls } = make();
    const report = (await backfill(app, { days: 40 })).json();
    expect(report.counts.outOfRange).toBeGreaterThan(0);
    expect(report.items.filter((i: any) => i.status === "out_of_range").every((i: any) => i.label === "außerhalb der Reichweite")).toBe(true);
    expect(calls.length).toBe(report.counts.loaded + report.counts.empty + report.counts.error);
  });

  it("answers 409 with a reason while a market is open", async () => {
    const { app, calls } = make({ now: D0 + 10 * H });
    const res = await backfill(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Xetra.*geöffnet/);
    expect(calls).toEqual([]);
  });

  it("answers 409 while a live simulation runs", async () => {
    const { app, calls } = make();
    const created = await app.inject({ method: "POST", url: "/api/simulations", payload: { name: "L", live: true } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    app.session.run(id);
    const before = calls.length;
    const res = await backfill(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Live-Simulation/);
    expect(calls.length).toBe(before);
  });

  it("refuses a second backfill while one is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { source } = makeSource();
    const slow: MarketData = { bars: async (s, f, t) => { await gate; return source.bars(s, f, t); } };
    const app = buildApp({ dbPath: ":memory:", marketData: slow, instruments: [SAP], now: () => NOW, minGapMs: 0, tickMs: 20 });
    open.push(app);
    const first = await post(app);
    expect(first.statusCode).toBe(202);
    const second = await post(app);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/läuft bereits/);
    release();
    for (let i = 0; i < 500 && (await get(app, "/api/archive/backfill")).json().running; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await get(app, "/api/archive/backfill")).json().running).toBe(false);
  });

  it("answers 202 at once with the job state, and GET follows it to the report", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { source } = makeSource();
    const slow: MarketData = { bars: async (s, f, t) => { await gate; return source.bars(s, f, t); } };
    const app = buildApp({ dbPath: ":memory:", marketData: slow, instruments: [SAP], now: () => NOW, minGapMs: 0, tickMs: 20 });
    open.push(app);
    const idle = (await get(app, "/api/archive/backfill")).json();
    expect(idle).toEqual({ running: false, startedAt: null, finishedAt: null, done: 0, total: 0, report: null });

    const res = await post(app);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ running: true, startedAt: NOW, finishedAt: null, done: 0, total: 14, report: null });
    const mid = (await get(app, "/api/archive/backfill")).json();
    expect(mid).toMatchObject({ running: true, finishedAt: null, total: 14, report: null });

    release();
    for (let i = 0; i < 500 && (await get(app, "/api/archive/backfill")).json().running; i++) await new Promise((r) => setTimeout(r, 5));
    const done = (await get(app, "/api/archive/backfill")).json();
    expect(done).toMatchObject({ running: false, startedAt: NOW, finishedAt: NOW, done: 14, total: 14 });
    expect(done.report).toMatchObject({ days: 7, stoppedByRateLimit: false });
    expect(done.report.items).toHaveLength(14);
  });

  it("rejects a bad range", async () => {
    const { app } = make();
    expect((await backfill(app, { days: 0 })).statusCode).toBe(400);
    expect((await backfill(app, { days: 61 })).statusCode).toBe(400);
  });
});
