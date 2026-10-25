import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AAPL, D0, H, SAP, makeSource } from "./fakes.js";

const NOW = D0 + 5 * 86400;
const START = D0 + 7 * H + 600;
const open: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const folder = () => {
  const d = mkdtempSync(join(tmpdir(), "deposim-test-"));
  dirs.push(d);
  return d;
};

function make(opts: { dir?: string; now?: number; backupDir?: string; keep?: number; instruments?: typeof SAP[] } = {}) {
  const dir = opts.dir ?? folder();
  const { source } = makeSource();
  const app = buildApp({
    dbPath: join(dir, "db.sqlite"), marketData: source, instruments: opts.instruments ?? [SAP, AAPL], now: () => opts.now ?? NOW,
    minGapMs: 0, tickMs: 20, backupDir: opts.backupDir, backupKeep: opts.keep,
  });
  open.push(app);
  return app;
}

const post = (app: FastifyInstance, url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

/** A simulation with a filled order, an open limit order, a second depot, a ghost, a note and a benchmark. */
async function busySim(app: FastifyInstance, name = "Busy") {
  const created = await post(app, "/api/simulations", { name, startAt: START });
  const id = created.json().id as number;
  const depot = app.session.defaultDepotId(id);
  expect(app.session.placeOrder(id, depot, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 5 }).ok).toBe(true);
  app.session.tick(id, 120_000);
  expect(app.session.placeOrder(id, depot, { symbol: "SAP.DE", side: "sell", kind: "market", qty: 2 }).ok).toBe(true);
  app.session.tick(id, 120_000);
  expect(app.session.placeOrder(id, depot, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 1 }).ok).toBe(true);
  await post(app, `/api/simulations/${id}/depots`, { name: "Zweit; \"Depot\"" });
  await post(app, `/api/simulations/${id}/depots/${depot}/ghost`, {});
  await app.inject({ method: "PATCH", url: `/api/simulations/${id}`, payload: { benchmark: "SAP.DE" } });
  const journal = (await app.inject({ url: `/api/simulations/${id}/journal` })).json();
  expect(journal.trades.length).toBeGreaterThan(0);
  const put = await app.inject({ method: "PUT", url: `/api/simulations/${id}/journal/${encodeURIComponent(journal.trades[0].key)}`, payload: { text: "Notiz eins" } });
  expect(put.statusCode).toBe(200);
  return id;
}

const evaluation = async (app: FastifyInstance, id: number) => (await app.inject({ url: `/api/simulations/${id}/evaluation` })).json();

describe("Gesamtsicherung", () => {
  it("delivers an openable file with every depot state and without the price archive", async () => {
    const app = make();
    const id = await busySim(app);
    const res = await app.inject({ url: "/api/backup" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="deposim-sicherung-\d{8}-\d{6}\.sqlite"/);
    const dir = folder();
    const file = join(dir, "b.sqlite");
    writeFileSync(file, res.rawPayload);
    const copy = new Database(file, { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    expect((copy.prepare("select count(*) n from orders").get() as { n: number }).n).toBe(3);
    expect((copy.prepare("select count(*) n from depots where simulation_id = ?").get(id) as { n: number }).n).toBe(3);
    expect((copy.prepare("select name from sqlite_master where name = 'bars'").get())).toBeUndefined();
    copy.close();
  });

  it("is whole while a writer keeps writing", async () => {
    const app = make();
    const id = await busySim(app);
    const writer = setInterval(() => app.session.tick(id, 1_000), 1);
    try {
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({ url: "/api/backup" });
        const file = join(folder(), "b.sqlite");
        writeFileSync(file, res.rawPayload);
        const copy = new Database(file, { readonly: true });
        expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
        copy.close();
      }
    } finally {
      clearInterval(writer);
    }
  });

  it("restores into an empty instance with the same figures", async () => {
    const a = make();
    const id = await busySim(a);
    const before = await evaluation(a, id);
    const curvesBefore = (await a.inject({ url: `/api/simulations/${id}/curves` })).json();
    const file = (await a.inject({ url: "/api/backup" })).rawPayload;

    // Empty of simulations; the price archive is loaded as it would be after a first look (it is not in the backup).
    const b = make();
    await b.session.start((await post(b, "/api/simulations", { name: "Leer", startAt: START })).json().id);
    const res = await b.inject({ method: "POST", url: "/api/backup/restore?confirm=ja", payload: file, headers: { "content-type": "application/octet-stream" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ simulations: 1 });
    expect(await evaluation(b, id)).toEqual(before);
    expect((await b.inject({ url: `/api/simulations/${id}/curves` })).json()).toEqual(curvesBefore);
    expect((await b.inject({ url: `/api/simulations/${id}/journal` })).json().notes ?? null).toEqual((await a.inject({ url: `/api/simulations/${id}/journal` })).json().notes ?? null);
  });

  it("asks for confirmation, saves the current state first and replaces it", async () => {
    const dir = folder();
    const backupDir = join(dir, "sicherungen");
    const app = make({ dir, backupDir });
    const id = await busySim(app);
    const file = (await app.inject({ url: "/api/backup" })).rawPayload;
    await post(app, "/api/simulations", { name: "Danach", startAt: START });
    expect((await app.inject({ url: "/api/simulations" })).json()).toHaveLength(2);
    const headers = { "content-type": "application/octet-stream" };

    const refused = await app.inject({ method: "POST", url: "/api/backup/restore", payload: file, headers });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Bestätigung/);
    expect((await app.inject({ url: "/api/simulations" })).json()).toHaveLength(2);

    const ok = await app.inject({ method: "POST", url: "/api/backup/restore?confirm=ja", payload: file, headers });
    expect(ok.statusCode).toBe(200);
    const saved = ok.json().savedBefore as string;
    expect(saved).toMatch(/^deposim-vor-wiederherstellung-/);
    expect(existsSync(join(backupDir, saved))).toBe(true);
    const names = (await app.inject({ url: "/api/simulations" })).json().map((s: { id: number }) => s.id);
    expect(names).toEqual([id]);
    // the safety copy holds the state from before: both simulations
    const pre = new Database(join(backupDir, saved), { readonly: true });
    expect((pre.prepare("select count(*) n from simulations").get() as { n: number }).n).toBe(2);
    pre.close();
  });

  it("refuses a file that is no backup, and changes nothing", async () => {
    const app = make();
    const id = await busySim(app);
    const before = await evaluation(app, id);
    const headers = { "content-type": "application/octet-stream" };
    for (const payload of [Buffer.from("das ist keine Datenbank"), Buffer.alloc(4096, 7)]) {
      const res = await app.inject({ method: "POST", url: "/api/backup/restore?confirm=ja", payload, headers });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Nichts wurde geändert/);
    }
    // an SQLite file that is not DepoSim's
    const other = join(folder(), "x.sqlite");
    const o = new Database(other);
    o.exec("create table t (a); insert into t values (1)");
    o.close();
    const res = await app.inject({ method: "POST", url: "/api/backup/restore?confirm=ja", payload: readFileSync(other), headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/keine Sicherung von DepoSim/);
    expect(await evaluation(app, id)).toEqual(before);
  });

  it("restores a backup made by an older schema", async () => {
    const old = join(folder(), "old.sqlite");
    const o = new Database(old);
    o.exec(`create table simulations (id integer primary key, name text not null, start_at integer not null, simulation_time integer not null,
      tempo integer not null, start_cash integer not null, fees_json text not null, created_at integer not null, ended_at integer);
      create table depots (id integer primary key, simulation_id integer not null, name text not null, cash integer not null);
      create table orders (id integer primary key, depot_id integer not null, symbol text not null, side text not null, kind text not null,
      qty integer not null, limit_price real, status text not null, created_sim integer not null, filled_sim integer, fill_price real,
      gross integer, commission integer, foreign_fee integer);
      insert into simulations values (7, 'Alt', 1, 1, 1, 100, '{}', 1, null);
      insert into depots values (3, 7, 'Depot 1', 100);`);
    o.close();
    const app = make();
    const res = await app.inject({ method: "POST", url: "/api/backup/restore?confirm=ja", payload: readFileSync(old), headers: { "content-type": "application/octet-stream" } });
    expect(res.statusCode).toBe(200);
    const list = (await app.inject({ url: "/api/simulations" })).json();
    expect(list).toMatchObject([{ id: 7, name: "Alt", live: false, benchmark: null }]);
  });
});

describe("Export und Import einer Simulation", () => {
  it("round-trips into a new simulation with new ids and the same figures", async () => {
    const app = make();
    const id = await busySim(app);
    const exported = await app.inject({ url: `/api/simulations/${id}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toMatch(/attachment; filename="simulation-\d+-[\d-]+\.json"/);
    const file = exported.json();
    expect(file).toMatchObject({ format: "deposim-simulation", version: 1 });

    const imported = await post(app, "/api/simulations/import", file);
    expect(imported.statusCode).toBe(201);
    const copy = imported.json();
    expect(copy.id).not.toBe(id);
    expect(copy.name).toBe("Busy (Import)");
    const again = await post(app, "/api/simulations/import", file);
    expect(again.json().name).toBe("Busy (Import 2)");

    const a = await evaluation(app, id);
    const b = await evaluation(app, copy.id);
    const strip = (e: any) => ({ ...e, correlation: { ...e.correlation, ids: [] }, depots: e.depots.map(({ id: _i, ...d }: any) => d) });
    expect(strip(b)).toEqual(strip(a));
    const ja = (await app.inject({ url: `/api/simulations/${id}/journal` })).json();
    const jb = (await app.inject({ url: `/api/simulations/${copy.id}/journal` })).json();
    expect(jb.trades.map((t: any) => t.note)).toEqual(ja.trades.map((t: any) => t.note));
    expect(jb.trades.some((t: any) => t.note === "Notiz eins")).toBe(true);
    expect(jb.trades.map((t: any) => t.key)).not.toEqual(ja.trades.map((t: any) => t.key));
    // the original is untouched
    expect(await evaluation(app, id)).toEqual(a);
  });

  it("refuses an unknown schema version with a clear message and changes nothing", async () => {
    const app = make();
    const id = await busySim(app);
    const file = (await app.inject({ url: `/api/simulations/${id}/export` })).json();
    for (const bad of [{ ...file, version: 2 }, { ...file, version: undefined }]) {
      const res = await post(app, "/api/simulations/import", bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Schemaversion/);
      expect(res.json().error).toMatch(/Nichts wurde geändert/);
    }
    expect((await post(app, "/api/simulations/import", { hello: 1 })).json().error).toMatch(/keine Simulationsdatei/);
    const broken = { ...file, depots: [{ ...file.depots[0], cash: "viel" }] };
    expect((await post(app, "/api/simulations/import", broken)).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/simulations" })).json()).toHaveLength(1);
  });

  it("refuses a file with a symbol this instance does not know, whole", async () => {
    const a = make();
    const id = await busySim(a);
    const file = (await a.inject({ url: `/api/simulations/${id}/export` })).json();
    const b = make({ instruments: [AAPL] });
    const res = await post(b, "/api/simulations/import", file);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/SAP\.DE/);
    expect((await b.inject({ url: "/api/simulations" })).json()).toEqual([]);
  });
});

describe("CSV", () => {
  it("writes orders with semicolon, decimal comma and a BOM, and quotes what needs it", async () => {
    const app = make();
    const id = await busySim(app);
    const res = await app.inject({ url: `/api/simulations/${id}/orders.csv` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv; charset=utf-8/);
    const bytes = res.rawPayload;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = res.body.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("Depot;Auftrag;Wertpapier;Seite;Art;Menge;Limit;Status;Erteilt (UTC);Ausgeführt (UTC);Kurs;Brutto;Provision;Fremdwährungsentgelt");
    expect(lines).toHaveLength(4);
    const filled = lines[1].split(";");
    expect(filled[2]).toBe("SAP.DE");
    expect(filled[3]).toBe("Kauf");
    expect(filled[7]).toBe("ausgeführt");
    expect(filled[11]).toMatch(/^\d+,\d{2}$/); // Brutto in euro with a comma
    expect(lines[3].split(";")[6]).toBe("1"); // the limit price, no decimals
  });

  it("writes the depot values and quotes a name with a semicolon or a quote", async () => {
    const app = make();
    const id = await busySim(app);
    const res = await app.inject({ url: `/api/simulations/${id}/values.csv` });
    expect(res.body).toContain('"Zweit; ""Depot"""');
    expect(res.body.split("\r\n")[0]).toBe("﻿Depot;Zeit (UTC);Depotwert");
    expect(res.body).toMatch(/Depot 1;2026-10-22 07:10:00;\d+,\d{2}/);
    expect((await app.inject({ url: "/api/simulations/9999/orders.csv" })).statusCode).toBe(404);
  });

  it("exports archive bars of a symbol as CSV", async () => {
    const app = make();
    await busySim(app);
    const res = await app.inject({ url: `/api/archive/export.csv?symbol=SAP.DE&kind=minute&from=${D0 + 7 * H}&to=${D0 + 7 * H + 180}` });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^2026-10-22 07:00:00;99,75;100,5;99,5;100;10$/);
    expect((await app.inject({ url: "/api/archive/export.csv?symbol=SAP.DE&from=5&to=1" })).statusCode).toBe(400);
  });

  it("does not let a formula through a depot name", async () => {
    const app = make();
    const id = await busySim(app);
    await post(app, `/api/simulations/${id}/depots`, { name: "=SUMME(A1)" });
    const res = await app.inject({ url: `/api/simulations/${id}/values.csv` });
    expect(res.body).toContain("'=SUMME(A1);");
    expect(res.body).not.toMatch(/(^|\r\n)=SUMME/);
  });
});

describe("Tagessicherung", () => {
  it("writes a file in the backup folder once a day and keeps the newest N", async () => {
    const dir = folder();
    const backupDir = join(dir, "b");
    let now = NOW;
    const { source } = makeSource();
    const app = buildApp({ dbPath: join(dir, "db.sqlite"), marketData: source, instruments: [SAP, AAPL], now: () => now, minGapMs: 0, backupDir, backupKeep: 3 });
    open.push(app);
    await busySim(app);
    await app.backup.runDaily();
    await app.backup.runDaily(); // the same day: no second file
    expect(readdirSync(backupDir)).toEqual(["deposim-tag-2026-10-27.sqlite"]);
    const first = new Database(join(backupDir, "deposim-tag-2026-10-27.sqlite"), { readonly: true });
    expect((first.prepare("select count(*) n from orders").get() as { n: number }).n).toBe(3);
    first.close();
    for (let i = 0; i < 4; i++) {
      now += 86400;
      await app.backup.runDaily();
    }
    expect(readdirSync(backupDir)).toEqual(["deposim-tag-2026-10-29.sqlite", "deposim-tag-2026-10-30.sqlite", "deposim-tag-2026-10-31.sqlite"]);
    const status = (await app.inject({ url: "/api/backup/status" })).json();
    expect(status).toMatchObject({ enabled: true, keep: 3, lastName: "deposim-tag-2026-10-31.sqlite", error: null });
    expect(status.log[0]).toMatchObject({ ok: true });
  });

  it("puts a failure into the job log and the status, and clears it after the next success", async () => {
    const dir = folder();
    const blocker = join(dir, "datei");
    writeFileSync(blocker, "x");
    const backupDir = join(blocker, "unter"); // cannot be created: a file is in the way
    const app = make({ dir, backupDir });
    await app.backup.runDaily();
    let status = (await app.inject({ url: "/api/backup/status" })).json();
    expect(status.error).toMatchObject({ message: expect.any(String) });
    expect(status.log[0]).toMatchObject({ ok: false });
    expect(status.log[0].text).toMatch(/fehlgeschlagen/);
    expect(status.lastAt).toBeNull();

    const good = make({ backupDir: join(folder(), "ok") });
    await good.backup.runDaily();
    status = (await good.inject({ url: "/api/backup/status" })).json();
    expect(status.error).toBeNull();
    expect(status.lastAt).toEqual(expect.any(Number));
  });

  it("reports no folder as disabled", async () => {
    const app = make();
    await app.backup.runDaily();
    expect((await app.inject({ url: "/api/backup/status" })).json()).toMatchObject({ enabled: false, dir: null, lastAt: null, error: null });
  });
});
