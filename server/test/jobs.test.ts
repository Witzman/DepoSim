import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { JOB_NAMES, readJobSettings } from "../src/config.js";
import { type MarketData, MarketDataError } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";
import { type JobDef, createJobs, slotsAround, zonedToUtc } from "../src/jobs.js";
import { AAPL, D0, D1, DAY, H, SAP, makeSource } from "./fakes.js";

const open: FastifyInstance[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** All jobs off except the named ones. */
const only = (...names: string[]) => ({
  enabled: true, overrides: Object.fromEntries(JOB_NAMES.filter((n) => !names.includes(n)).map((n) => [n, "off" as const])),
});

function make(opts: { now: { t: number }; names: string[]; source?: MarketData; enabled?: boolean }) {
  const { source } = makeSource();
  const calls: string[] = [];
  const wrapped: MarketData = opts.source ?? {
    async bars(symbol, fromT, toT) {
      calls.push(`${symbol}@${fromT}`);
      return source.bars(symbol, fromT, toT);
    },
  };
  const app = buildApp({
    dbPath: ":memory:", marketData: wrapped, instruments: [SAP, AAPL], now: () => opts.now.t, minGapMs: 0, tickMs: 20,
    jobSettings: { ...only(...opts.names), enabled: opts.enabled ?? true },
  });
  open.push(app);
  return { app, calls, jobs: app.jobs };
}

const runs = (app: FastifyInstance) =>
  app.inject({ url: "/api/jobs" }).then((r) => r.json().runs as { job: string; status: string; message: string; counts: Record<string, number>; trigger: string }[]);

describe("schedule", () => {
  it("finds the Berlin time in summer and winter", () => {
    expect(zonedToUtc("Europe/Berlin", "2026-10-22", "18:00")).toBe(D0 + 16 * H); // CEST
    expect(zonedToUtc("Europe/Berlin", "2026-12-01", "18:00")).toBe(Date.parse("2026-12-01T17:00:00Z") / 1000); // CET
    // The day the clocks go back (2026-10-25): 02:30 exists once, after the change.
    expect(zonedToUtc("Europe/Berlin", "2026-10-26", "02:30")).toBe(Date.parse("2026-10-26T01:30:00Z") / 1000);
  });

  it("knows the last and the next time", () => {
    const { last, next } = slotsAround("18:00", D0 + 17 * H);
    expect(last).toBe(D0 + 16 * H);
    expect(next).toBe(D0 + DAY + 16 * H);
    expect(slotsAround("18:00", D0 + 15 * H).last).toBe(D0 - DAY + 16 * H);
  });
});

describe("settings", () => {
  it("is on by default, JOBS=off switches the schedule off, a job takes off or a new time", () => {
    expect(readJobSettings({}).enabled).toBe(true);
    expect(readJobSettings({ JOBS: "off" }).enabled).toBe(false);
    expect(readJobSettings({ JOBS: "on" }).enabled).toBe(true);
    expect(readJobSettings({ JOB_LUECKEN: "off", JOB_SAMMLUNG_US: "23:15", JOB_PFLEGE: "25:00", JOB_TAGESKURSE: "x" }).overrides)
      .toEqual({ luecken: "off", "sammlung-us": "23:15" });
  });
});

describe("collection after the close", () => {
  it("loads the day of every listed value of the market, once, and writes the log", async () => {
    const now = { t: D0 + 16.5 * H };
    const { app, calls, jobs } = make({ now, names: ["sammlung-xetra"] });
    await jobs.tick();
    expect(calls).toEqual([`${SAP.symbol}@${D0}`]); // not AAPL: other market
    const [r] = await runs(app);
    expect(r).toMatchObject({ job: "sammlung-xetra", status: "ok", trigger: "plan", counts: { loaded: 1 } });
    expect(r.message).toContain("Xetra 2026-10-22");
    await jobs.tick(); // same time slot: nothing again
    expect(calls).toHaveLength(1);
    expect(await runs(app)).toHaveLength(1);
  });

  it("runs again after the next time", async () => {
    const now = { t: D0 + 16.5 * H };
    const { app, calls, jobs } = make({ now, names: ["sammlung-xetra"] });
    await jobs.tick();
    now.t = D1 + 16.5 * H;
    await jobs.tick();
    expect(calls).toEqual([`${SAP.symbol}@${D0}`, `${SAP.symbol}@${D1}`]);
    expect(await runs(app)).toHaveLength(2);
  });

  it("does not ask Yahoo on a holiday or a weekend", async () => {
    // Good Friday 2026-04-03, a Xetra holiday; Saturday 2026-10-24.
    for (const day of ["2026-04-03", "2026-10-24"]) {
      const now = { t: Date.parse(`${day}T16:30:00Z`) / 1000 };
      const { app, calls, jobs } = make({ now, names: ["sammlung-xetra"] });
      await jobs.tick();
      expect(calls).toEqual([]);
      const [r] = await runs(app);
      expect(r.status).toBe("ok");
      expect(r.message).toMatch(/kein Handelstag \((Feiertag: Karfreitag|Wochenende)\)/);
    }
  });

  it("a US holiday skips the US collection but not the Xetra one", async () => {
    // Thanksgiving 2026-11-26: Xetra trades, NYSE is shut.
    const now = { t: Date.parse("2026-11-26T21:30:00Z") / 1000 };
    const { app, jobs } = make({ now, names: ["sammlung-xetra", "sammlung-us"] });
    await jobs.tick();
    const byJob = Object.fromEntries((await runs(app)).map((r) => [r.job, r.message]));
    expect(byJob["sammlung-us"]).toContain("kein Handelstag (Feiertag: Thanksgiving");
    expect(byJob["sammlung-xetra"]).not.toContain("kein Handelstag");
  });

  it("leaves a day that is not over as incomplete, for the gap repair of the night", async () => {
    const now = { t: D0 + 16.5 * H };
    const { app, jobs } = make({ now, names: ["sammlung-xetra"] });
    await jobs.tick();
    const incomplete = (a: FastifyInstance) =>
      a.inject({ url: "/api/archive/missing?days=1" }).then((r) => r.json().items.length);
    expect(await incomplete(app)).toBeGreaterThan(0); // D0 is not over at 16:30 UTC: complete = 0
  });
});

describe("the gap repair", () => {
  it("fills the finished days of the last 29 days and skips weekends", async () => {
    const now = { t: D0 + 5 * DAY + 2 * H }; // Tuesday night 2026-10-27
    const { app, calls, jobs } = make({ now, names: ["luecken"] });
    await jobs.tick();
    const [r] = await runs(app);
    expect(r).toMatchObject({ job: "luecken", status: "ok" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.startsWith(`${SAP.symbol}@${D0}`))).toBe(true);
    // no Saturday/Sunday for the shares (2026-10-24/25)
    expect(calls.some((c) => c.startsWith("SAP.DE@") && [D0 + 2 * DAY, D0 + 3 * DAY].includes(Number(c.split("@")[1])))).toBe(false);
    const before = calls.length;
    now.t += 3600;
    await jobs.tick();
    expect(calls.length).toBe(before);
  });

  it("stops at the first 429, shows the rest as skipped, and the next day loads it", async () => {
    const now = { t: D0 + 5 * DAY + 2 * H };
    const { source } = makeSource();
    let limit = true;
    let n = 0;
    const calls: string[] = [];
    const limited: MarketData = {
      async bars(symbol, fromT, toT) {
        calls.push(`${symbol}@${fromT}`);
        if (limit && ++n === 3) throw new MarketDataError("rate_limited", "fake 429");
        return source.bars(symbol, fromT, toT);
      },
    };
    const { app, jobs } = make({ now, names: ["luecken"], source: limited });
    await jobs.tick();
    expect(calls).toHaveLength(3); // nothing after the 429
    const [first] = await runs(app);
    expect(first.status).toBe("partial");
    expect(first.counts.rateLimited).toBe(1);
    expect(first.counts.skipped).toBeGreaterThan(0);
    expect(first.message).toContain("429");

    limit = false;
    now.t += DAY; // the next night
    await jobs.tick();
    const [second] = await runs(app);
    expect(second.status).toBe("ok");
    expect(calls.length).toBeGreaterThan(3);
    // Nothing doubled in the archive: bars have a primary key and the fetch ignores a repeat.
    const bars = await app.inject({ url: `/api/archive/missing?days=5` });
    expect(bars.statusCode).toBe(200);
  });
});

describe("one at a time, live first", () => {
  const def = (name: string, log: string[], usesSource = false): JobDef => ({
    name, label: name, at: "02:30", usesSource,
    async run(ctx) {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 15));
      log.push(`end ${name}${ctx.shouldStop() ? " (stop)" : ""}`);
      return { status: "ok", message: "ok" };
    },
  });
  const jobs = (defs: JobDef[], live: { on: boolean }, t = D0 + 3 * H) =>
    createJobs({ db: openDb(":memory:"), now: () => t, defs, settings: { enabled: true, overrides: {} }, liveBusy: () => live.on });

  it("two jobs due at the same time run one after the other, never together", async () => {
    const log: string[] = [];
    const j = jobs([def("a", log), def("b", log), def("c", log)], { on: false });
    await j.tick();
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(j.list().every((x) => x.lastRun?.status === "ok")).toBe(true);
  });

  it("a hand start in the middle of a run waits its turn", async () => {
    const log: string[] = [];
    const j = jobs([def("a", log), def("b", log)], { on: false });
    const p = j.tick();
    expect(j.run("b")).toMatchObject({ ok: false, code: 409 }); // queued already
    expect(j.run("zzz")).toMatchObject({ ok: false, code: 404 });
    await p;
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("a live simulation has priority: jobs that call a source wait, the others go on", async () => {
    const log: string[] = [];
    const live = { on: true };
    const j = jobs([def("source", log, true), def("local", log, false)], live);
    await j.tick();
    expect(log).toEqual(["start local", "end local"]);
    expect(j.run("source")).toMatchObject({ ok: false, code: 409, reason: expect.stringContaining("Live-Simulation") });
    live.on = false;
    await j.tick();
    expect(log).toEqual(["start local", "end local", "start source", "end source"]);
  });

  it("a live simulation that starts during a run stops it: the run says so and is tried again", async () => {
    const live = { on: false };
    const db = openDb(":memory:");
    let calls = 0;
    const d: JobDef = {
      name: "s", label: "s", at: "02:30", usesSource: true,
      async run(ctx) {
        calls++;
        live.on = true;
        const reason = ctx.shouldStop();
        return reason ? { status: "aborted", message: reason } : { status: "ok", message: "ok" };
      },
    };
    const j = createJobs({ db, now: () => D0 + 3 * H, defs: [d], settings: { enabled: true, overrides: {} }, liveBusy: () => live.on });
    await j.tick();
    expect(j.list()[0].lastRun).toMatchObject({ status: "aborted", message: "Eine Live-Simulation läuft" });
    live.on = false;
    await j.tick();
    expect(calls).toBe(2);
    expect(j.list()[0].lastRun?.status).toBe("aborted"); // live on again inside the run
  });
});

describe("restart", () => {
  it("a run that was open at the end is shown as aborted, and the next look runs the job again", async () => {
    const db = openDb(":memory:");
    db.prepare("insert into job_runs (job, trigger, slot, started_at, status) values ('x', 'plan', ?, ?, 'running')").run(D0 + 2 * H, D0 + 2 * H);
    let calls = 0;
    const d: JobDef = { name: "x", label: "x", at: "04:00", usesSource: false, async run() { calls++; return { status: "ok", message: "ok" }; } };
    const j = createJobs({ db, now: () => D0 + 3 * H, defs: [d], settings: { enabled: true, overrides: {} }, liveBusy: () => false });
    const rows = j.runs();
    expect(rows[0]).toMatchObject({ status: "aborted", label: "abgebrochen" });
    expect(rows[0].error).toContain("neu gestartet");
    await j.tick();
    expect(calls).toBe(1);
    expect(j.runs().map((r) => r.status)).toEqual(["ok", "aborted"]);
  });

  it("an unexpected failure is logged, not thrown, and not tried again before the next day (unless the job asks for it)", async () => {
    const db = openDb(":memory:");
    let n = 0;
    const bad: JobDef = { name: "bad", label: "bad", at: "02:30", usesSource: false, async run() { n++; throw new Error("kaputt"); } };
    const retry: JobDef = { ...bad, name: "retry", retryErrorS: 3600 };
    const t = { v: D0 + 3 * H };
    const j = createJobs({ db, now: () => t.v, defs: [bad, retry], settings: { enabled: true, overrides: {} }, liveBusy: () => false });
    await j.tick();
    expect(n).toBe(2);
    expect(j.list()[0].lastRun).toMatchObject({ status: "error", error: expect.stringContaining("kaputt") });
    t.v += 1800;
    await j.tick();
    expect(n).toBe(2);
    t.v += 3600;
    await j.tick();
    expect(n).toBe(3); // only "retry"
  });
});

describe("switched off", () => {
  it("JOBS=off runs nothing by itself, a hand start still works", async () => {
    const now = { t: D0 + 16.5 * H };
    const { app, calls, jobs } = make({ now, names: ["sammlung-xetra"], enabled: false });
    await jobs.tick();
    expect(calls).toEqual([]);
    const res = await app.inject({ url: "/api/jobs" });
    expect(res.json()).toMatchObject({ enabled: false });
    expect(res.json().jobs.every((j: { enabled: boolean; nextAt: number | null }) => !j.enabled && j.nextAt === null)).toBe(true);
    const run = await app.inject({ method: "POST", url: "/api/jobs/sammlung-xetra/run" });
    expect(run.statusCode).toBe(202);
    await jobs.settled();
    expect(calls).toEqual([`${SAP.symbol}@${D0}`]);
    expect((await runs(app))[0].trigger).toBe("hand");
  });

  it("a single job can be off or moved", async () => {
    const now = { t: D0 + 5 * H };
    const { app } = make({ now, names: [] });
    const body = (await app.inject({ url: "/api/jobs" })).json();
    expect(body.jobs.map((j: { name: string }) => j.name)).toContain("sammlung-xetra");
    expect(body.jobs.find((j: { name: string }) => j.name === "luecken")).toMatchObject({ enabled: false, schedule: "aus" });
  });
});

describe("API", () => {
  it("lists the jobs with schedule and next time, and answers 404 for an unknown job", async () => {
    const now = { t: D0 + 5 * H };
    const app = buildApp({ dbPath: ":memory:", instruments: [SAP], now: () => now.t, minGapMs: 0 });
    open.push(app);
    const body = (await app.inject({ url: "/api/jobs" })).json();
    expect(body.enabled).toBe(true);
    const x = body.jobs.find((j: { name: string }) => j.name === "sammlung-us");
    expect(x).toMatchObject({ schedule: "täglich 22:30 (Europe/Berlin)", enabled: true, nextAt: D0 + 20.5 * H, lastRun: null });
    expect(body.jobs.map((j: { name: string }) => j.name)).not.toContain("sicherung"); // no backup folder set
    expect((await app.inject({ method: "POST", url: "/api/jobs/nope/run" })).statusCode).toBe(404);
  });
});

describe("the backup job", () => {
  it("writes the daily backup through the scheduler, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deposim-jobs-"));
    try {
      const now = { t: D0 + 3 * H }; // after 03:00 Berlin
      const app = buildApp({
        dbPath: join(dir, "db.sqlite"), instruments: [SAP], now: () => now.t, minGapMs: 0,
        backupDir: join(dir, "backups"), jobSettings: only("sicherung"),
      });
      open.push(app);
      await app.jobs.tick();
      expect(readdirSync(join(dir, "backups"))).toEqual(["deposim-tag-2026-10-22.sqlite"]);
      const [r] = await runs(app);
      expect(r).toMatchObject({ job: "sicherung", status: "ok" });
      expect(r.message).toContain("Tagessicherung");
      expect((await app.inject({ url: "/api/backup/status" })).json().lastName).toBe("deposim-tag-2026-10-22.sqlite");
      await app.jobs.tick();
      expect(await runs(app)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the rate job", () => {
  it("fetches the ECB rates at the scheduled time and writes the result", async () => {
    const now = { t: Date.parse("2026-10-23T16:00:00Z") / 1000 }; // after 16:30 Berlin (14:30 UTC)
    let fetched = 0;
    const app = buildApp({
      dbPath: ":memory:", instruments: [SAP], now: () => now.t, minGapMs: 0,
      jobSettings: only("wechselkurse"),
      fxSource: { async fetch() { fetched++; return [{ day: "2026-10-23", rates: { USD: 1.08 } }] as never; } },
    });
    open.push(app);
    await app.jobs.tick();
    expect(fetched).toBe(1);
    expect((await runs(app))[0]).toMatchObject({ job: "wechselkurse", status: "ok" });
    await app.jobs.tick();
    expect(fetched).toBe(1);
  });
});
