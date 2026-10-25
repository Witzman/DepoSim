import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { type JobDef, createJobs } from "../src/jobs.js";
import { AAPL, D0, H, SAP, makeSource } from "./fakes.js";

const NOW = D0 + 5 * 86400;
const START = D0 + 7 * H + 600;
const open: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function make() {
  const dir = mkdtempSync(join(tmpdir(), "deposim-fixes-"));
  dirs.push(dir);
  const { source } = makeSource();
  const app = buildApp({ dbPath: join(dir, "db.sqlite"), marketData: source, instruments: [SAP, AAPL], now: () => NOW, minGapMs: 0, tickMs: 20 });
  open.push(app);
  const side = new Database(join(dir, "db.sqlite")); // a second connection, to put in and read what the API has no way to
  return { app, side };
}

const post = (app: FastifyInstance, url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
const count = (db: Database.Database, table: string) => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe("restore", () => {
  it("brings back the dividend bookings and the hint settings, not only the depots", async () => {
    const { app, side } = make();
    const id = (await post(app, "/api/simulations", { name: "Mit Buchung", startAt: START })).json().id as number;
    const depot = app.session.defaultDepotId(id);
    side.prepare("insert into cash_events (depot_id, t, kind, symbol, ref, amount, text) values (?, ?, 'dividend', 'SAP.DE', '2026-10-22', 1234, 'Ausschüttung SAP.DE')").run(depot, START);
    expect((await app.inject({ method: "PUT", url: `/api/simulations/${id}/hints/largest`, payload: { enabled: false } })).statusCode).toBe(204);
    const file = (await app.inject({ url: "/api/backup" })).rawPayload;

    const restored = await app.inject({ method: "POST", url: "/api/backup/restore?confirm=ja", payload: file, headers: { "content-type": "application/octet-stream" } });
    expect(restored.statusCode).toBe(200);
    expect(count(side, "cash_events")).toBe(1);
    expect(side.prepare("select enabled from hint_prefs where rule = 'largest'").get()).toEqual({ enabled: 0 });
    expect((await app.inject({ url: `/api/simulations/${id}/journal` })).json().bookings).toHaveLength(1);
  });
});

describe("export and import of one simulation", () => {
  it("keeps the scenario, its end, the auto-pause and the tax settings", async () => {
    const { app, side } = make();
    const id = (await post(app, "/api/simulations", { name: "Szenario", startAt: START })).json().id as number;
    side.prepare("update simulations set scenario_id = 'corona-crash-2020', end_at = ?, auto_pause = ?, tax = ? where id = ?")
      .run(START + 1000, JSON.stringify({ onFill: true }), JSON.stringify({ enabled: true, church: 0.09 }), id);
    const file = (await app.inject({ url: `/api/simulations/${id}/export` })).json();
    expect(file.version).toBe(1);
    const imported = await post(app, "/api/simulations/import", file);
    expect(imported.statusCode).toBe(201);
    const row = side.prepare("select scenario_id, end_at, auto_pause, tax from simulations where id = ?").get(imported.json().id) as Record<string, string | number>;
    expect(row.scenario_id).toBe("corona-crash-2020");
    expect(row.end_at).toBe(START + 1000);
    expect(JSON.parse(row.auto_pause as string)).toMatchObject({ onFill: true });
    expect(JSON.parse(row.tax as string)).toMatchObject({ enabled: true, church: 0.09 });
  });

  it("reads a file without those fields (an older export) and plays it as a free round", async () => {
    const { app, side } = make();
    const id = (await post(app, "/api/simulations", { name: "Alt", startAt: START })).json().id as number;
    const file = (await app.inject({ url: `/api/simulations/${id}/export` })).json();
    for (const k of ["scenarioId", "endAt", "autoPause", "tax"]) delete file.simulation[k];
    const imported = await post(app, "/api/simulations/import", file);
    expect(imported.statusCode).toBe(201);
    expect(side.prepare("select scenario_id, end_at from simulations where id = ?").get(imported.json().id)).toEqual({ scenario_id: null, end_at: null });
  });
});

describe("the scheduler", () => {
  it("goes on after the job log could not be written once", async () => {
    let t = NOW;
    let broken = false;
    const now = () => { if (broken) { broken = false; throw new Error("disk full"); } return t; };
    const ran: string[] = [];
    const def: JobDef = { name: "x", label: "X", at: "03:00", usesSource: false, async run() { ran.push("x"); return { status: "ok", message: "m" }; } };
    const jobs = createJobs({ db: openDb(":memory:"), now, defs: [def], settings: { enabled: true, overrides: {} }, liveBusy: () => false });
    expect(jobs.run("x")).toEqual({ ok: true });
    broken = true; // the next read of the clock is the one that writes the log row
    await expect(jobs.settled()).resolves.toBeUndefined();
    expect(jobs.list()[0]).toMatchObject({ running: false, queued: false });
    t += 10;
    expect(jobs.run("x")).toEqual({ ok: true }); // not "already running"
    await jobs.settled();
    expect(ran).toEqual(["x"]);
    expect(jobs.runs().map((r) => r.status)).toEqual(["ok"]);
  });
});

describe("the API", () => {
  it("turns away a hint rule that is only a property of every object", async () => {
    const { app } = make();
    const id = (await post(app, "/api/simulations", { name: "H", startAt: START })).json().id as number;
    for (const rule of ["constructor", "toString", "__proto__"]) {
      const res = await app.inject({ method: "PUT", url: `/api/simulations/${id}/hints/${rule}`, payload: { levels: [0.5] } });
      expect(res.statusCode, rule).toBe(400);
    }
  });

  it("refuses a request that a page of another site started, and lets the own page and plain clients through", async () => {
    const { app } = make();
    const url = "/api/venues";
    expect((await app.inject({ url, headers: { host: "depo.example", origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ url, headers: { host: "depo.example", origin: "null" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/jobs/luecken/run", headers: { host: "depo.example", origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ url, headers: { host: "depo.example", origin: "https://depo.example" } })).statusCode).toBe(200);
    expect((await app.inject({ url, headers: { host: "depo.example" } })).statusCode).toBe(200);
  });

  it("says that minute prices reach back 29 days, before it asks the source", async () => {
    const { app } = make();
    const res = await post(app, "/api/simulations", { name: "Zu alt", startAt: NOW - 40 * 86400 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Minutenkurse gibt es nur für die letzten 29 Tage/);
  });
});
