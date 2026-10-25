import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { DEFAULT_FEES } from "../src/domain/fees.js";
import { MarketDataError } from "../src/data/marketdata.js";
import { describeError, publicError } from "../src/errors.js";
import { createStore } from "../src/store.js";
import { type JobDef, createJobs } from "../src/jobs.js";
import { AAPL, D0, D1, H, SAP, makeSource } from "./fakes.js";

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

describe("the watchlist", () => {
  it("knows a symbol that has history: a filled order or a booking", () => {
    const store = createStore(openDb(":memory:"));
    const sim = store.createSimulation({ name: "S", startAt: 1000, startCash: 1_000_000, fees: DEFAULT_FEES });
    const depot = store.listDepots(sim.id)[0];
    expect(store.symbolHasHistory("SAP.DE")).toBe(false);
    const open = store.insertOrder(depot.id, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 10 }, 1000);
    expect(store.symbolHasHistory("SAP.DE")).toBe(false); // an open order is `symbolInUse`, not history
    store.markFilled(open, { filledSim: 1100, fillPrice: 10, gross: 1000, commission: 490, foreignFee: 0 });
    expect(store.symbolHasHistory("SAP.DE")).toBe(true);
    expect(store.symbolHasHistory("AAPL")).toBe(false);
    store.addBooking(depot.id, { t: 1200, kind: "dividend", symbol: "AAPL", ref: "2026-10-22", amount: 5, text: "x" });
    expect(store.symbolHasHistory("AAPL")).toBe(true);
  });
});

describe("the tick", () => {
  it("repeats the orders of a depot only when they changed", async () => {
    const { app } = make();
    const id = (await post(app, "/api/simulations", { name: "Tick", startAt: START })).json().id as number;
    expect((await post(app, `/api/simulations/${id}/orders`, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 1 })).statusCode).toBe(201);
    await app.ready();
    const msgs: any[] = [];
    const ws = await app.injectWS(`/ws/simulations/${id}`, {}, { onInit: (w: any) => w.on("message", (d: Buffer) => msgs.push(JSON.parse(String(d)))) });
    const until = async (cond: () => boolean) => { const end = Date.now() + 3000; while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
    const ticks = () => msgs.filter((m) => m.type === "tick");
    ws.send(JSON.stringify({ type: "tempo", tempo: 5 }));
    ws.send(JSON.stringify({ type: "run" }));
    await until(() => ticks().length >= 4);
    expect(msgs[0].depots[0].orders).toHaveLength(1); // the snapshot has them
    expect(ticks()[0].depots[0].orders).toHaveLength(1); // the first tick says what it sent last: nothing yet
    expect(ticks().slice(1).every((t) => !("orders" in t.depots[0]))).toBe(true);

    const seen = ticks().length;
    expect((await post(app, `/api/simulations/${id}/orders`, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 2 })).statusCode).toBe(201);
    await until(() => ticks().slice(seen).some((t) => t.depots[0].orders?.length === 2));
    ws.send(JSON.stringify({ type: "pause" }));
    ws.close();
  });
});

describe("the light", () => {
  it("does not count the day before as a gap until the night repair had its time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deposim-light-"));
    dirs.push(dir);
    const path = join(dir, "d.sqlite");
    const seed = openDb(path);
    for (let i = 0; i < 30; i++) {
      const t = D0 + 7 * H + i * 60;
      seed.prepare("insert into bars (symbol, t, o, h, l, c, v) values ('SAP.DE', ?, 1, 1, 1, 1, 1)").run(t);
    }
    seed.prepare("insert into fetched_days (symbol, day_start, complete) values ('SAP.DE', ?, 0)").run(D0); // the evening collection: cut off at midnight
    seed.close();
    const clock = { t: D1 + 1 * H };
    const { source } = makeSource();
    const app = buildApp({ dbPath: path, marketData: source, instruments: [SAP, AAPL], now: () => clock.t, minGapMs: 0, jobSettings: { enabled: false, overrides: {} } });
    open.push(app);
    const cell = async () => (await app.inject({ url: "/api/data/coverage?days=2" })).json().rows.find((r: any) => r.symbol === "SAP.DE").cells[0];
    expect(await cell()).toMatchObject({ day: "2026-10-22", state: "partial", today: true });
    const early = (await app.inject({ url: "/api/data/status" })).json().gapCells;
    clock.t = D1 + 4 * H;
    expect(await cell()).toMatchObject({ today: false });
    expect((await app.inject({ url: "/api/data/status" })).json().gapCells).toBeGreaterThan(early);
  });
});

describe("what a person is told about an error", () => {
  it("keeps the words for a source error and hides the text of anything else", () => {
    const secret = new Error("SQLITE_CANTOPEN: unable to open /data/deposim.sqlite");
    expect(publicError(secret)).not.toMatch(/sqlite|data/i);
    expect(describeError(secret)).toMatch(/SQLITE_CANTOPEN/); // the job log keeps the detail
    expect(publicError(new MarketDataError("rate_limited", "x"))).toBe(describeError(new MarketDataError("rate_limited", "x")));
  });
});

describe("the list of instruments after a restore", () => {
  it("reads the table again, because the restore replaced it", async () => {
    const { app, side } = make();
    const names = async () => (await app.inject({ url: "/api/watchlist" })).json().map((i: { symbol: string }) => i.symbol);
    expect(await names()).toEqual(["SAP.DE", "AAPL"]); // read once, now cached
    side.prepare("insert into instruments (symbol, name, currency, venue, position) values ('MSFT', 'Microsoft', 'USD', 'US', 1)").run();
    const file = (await app.inject({ url: "/api/backup" })).rawPayload;
    const restored = await app.inject({ method: "POST", url: "/api/backup/restore?confirm=ja", payload: file, headers: { "content-type": "application/octet-stream" } });
    expect(restored.statusCode).toBe(200);
    expect(await names()).toEqual(["SAP.DE", "AAPL", "MSFT"]);
  });
});

describe("a long jump", () => {
  it("can be played in pieces: a piece stops short of the target without saying why, and the next one goes on", async () => {
    const { app } = make();
    const id = (await post(app, "/api/simulations", { name: "Sprung", startAt: START })).json().id as number;
    const first = app.session.jump(id, "hour", undefined, 600);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.simulationTime).toBeLessThan(first.target);
    expect(first.simulationTime).toBeLessThanOrEqual(START + 600);
    expect(first.stopped).toBeNull();
    const second = app.session.playTo(id, first.target, 600);
    expect(second.simulationTime).toBeGreaterThan(first.simulationTime);
  });
});

describe("the journal and a split", () => {
  it("counts the pieces bought before a split as the pieces after it, so that a sale of all of them closes all of them", async () => {
    const { adjustForSplits, buildJournal } = await import("../src/domain/journal.js");
    const buy = { id: 1, symbol: "X", side: "buy" as const, qty: 10, fillPrice: 100, filledSim: 1000, gross: 100_000, commission: 0, foreignFee: 0 };
    const sell = { id: 2, symbol: "X", side: "sell" as const, qty: 20, fillPrice: 60, filledSim: 3000, gross: 120_000, commission: 0, foreignFee: 0 };
    const bars = { lastCompleteBar: () => undefined, nextBarAfter: () => undefined };
    const plain = buildJournal({ orders: [buy, sell], s: 4000, bars, notes: {} });
    expect(plain.trades[0].qty).toBe(10); // half of the sale has no purchase to close
    const split = adjustForSplits([buy, sell], [{ symbol: "X", t: 2000, numerator: 2, denominator: 1 }]);
    expect(split[0]).toMatchObject({ qty: 20, fillPrice: 50, gross: 100_000 });
    expect(split[1]).toBe(sell); // after the split: unchanged
    const fixed = buildJournal({ orders: split, s: 4000, bars, notes: {} });
    expect(fixed.trades).toHaveLength(1);
    expect(fixed.trades[0]).toMatchObject({ qty: 20, netPnl: 20_000 });
    expect(adjustForSplits([buy], [])).toEqual([buy]);
    expect(adjustForSplits([buy], [{ symbol: "Y", t: 2000, numerator: 2, denominator: 1 }])[0]).toBe(buy);
  });
});
