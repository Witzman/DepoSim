import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DEFAULT_FEES, previewCost } from "../src/domain/fees.js";
import { PRESETS, RELAXED, applyRules, resolveRules } from "../src/domain/rules.js";
import { openDb } from "../src/db.js";
import { createStore } from "../src/store.js";
import { AAPL, D0, H, SAP, makeSource } from "./fakes.js";

describe("resolveRules", () => {
  it("is relaxed without input and keeps a preset name when no switch differs", () => {
    expect(resolveRules()).toEqual(RELAXED);
    expect(resolveRules("hardcore", { spreadFactor: 2 }).preset).toBe("hardcore");
  });

  it("is custom as soon as a switch differs from the preset", () => {
    const r = resolveRules("realistic", { maxPositions: 3, pauseAllowed: undefined });
    expect(r.preset).toBe("custom");
    expect(r.maxPositions).toBe(3);
    expect(r.pauseAllowed).toBe(true);
  });

  it("makes hardcore a game without pause, with fixed tempo, double spread and fees", () => {
    expect(PRESETS.hardcore).toMatchObject({ pauseAllowed: false, tempoLocked: true, spreadFactor: 2, feeFactor: 2, allowFork: false });
  });
});

describe("applyRules", () => {
  it("leaves the fees alone for factor 1", () => {
    expect(applyRules(DEFAULT_FEES, RELAXED)).toEqual(DEFAULT_FEES);
  });

  it("scales spread and fees, and a preview with them equals what the execution of the same fees pays", () => {
    const fees = applyRules(DEFAULT_FEES, resolveRules("hardcore"));
    expect(fees.spreadPct).toBeCloseTo(DEFAULT_FEES.spreadPct * 2, 12);
    expect(fees.commissionMin).toBe(DEFAULT_FEES.commissionMin * 2);
    expect(fees.foreignFlat).toBe(DEFAULT_FEES.foreignFlat * 2);
    const ref = { price: 100, currency: "EUR" as const };
    const relaxed = previewCost("buy", 10, ref, "market", undefined, DEFAULT_FEES);
    const hard = previewCost("buy", 10, ref, "market", undefined, fees);
    expect(hard.execPrice).toBeGreaterThan(relaxed.execPrice);
    expect(hard.commission).toBe(relaxed.commission * 2);
  });
});

describe("store", () => {
  it("gives an old database the relaxed rules", () => {
    const db = openDb(":memory:");
    db.exec("alter table simulations drop column rules_json");
    db.prepare("insert into simulations (name, start_at, simulation_time, tempo, start_cash, fees_json, created_at) values ('Alt', 1, 1, 1, 1, '{}', 1)").run();
    // Opening again, as a restart would, adds the column back with the default.
    db.exec("alter table simulations add column rules_json text not null default '" + JSON.stringify(RELAXED) + "'");
    expect(createStore(db).listSimulations()[0].rules).toEqual(RELAXED);
  });
});

const open: FastifyInstance[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
function make() {
  const { source } = makeSource();
  const app = buildApp({ dbPath: ":memory:", marketData: source, instruments: [SAP, AAPL], now: () => D0 + 5 * 86400, minGapMs: 0, tickMs: 20 });
  open.push(app);
  return app;
}
const START = D0 + 7 * H + 600;
const post = (app: FastifyInstance, url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

describe("creating with rules", () => {
  it("stores the preset and shows it, with the factors folded into the fees", async () => {
    const app = make();
    const res = await post(app, "/api/simulations", { name: "H", startAt: START, preset: "hardcore" });
    expect(res.statusCode).toBe(201);
    const sim = res.json();
    expect(sim.rules).toMatchObject({ preset: "hardcore", pauseAllowed: false, tempoLocked: true });
    expect(sim.fees.spreadPct).toBeCloseTo(DEFAULT_FEES.spreadPct * 2, 12);
    expect((await app.inject({ url: "/api/simulations" })).json()[0].rules.preset).toBe("hardcore");
  });

  it("takes single switches and rejects nonsense with a 400", async () => {
    const app = make();
    const ok = await post(app, "/api/simulations", { name: "C", startAt: START, preset: "realistic", rules: { maxPositions: 2 } });
    expect(ok.json().rules).toMatchObject({ preset: "custom", maxPositions: 2 });
    expect((await post(app, "/api/simulations", { name: "X", startAt: START, rules: { spreadFactor: 99 } })).statusCode).toBe(400);
    expect((await post(app, "/api/simulations", { name: "X", startAt: START, preset: "easy" })).statusCode).toBe(400);
  });

  it("makes a simulation without rules a relaxed one", async () => {
    const app = make();
    const sim = (await post(app, "/api/simulations", { name: "R", startAt: START })).json();
    expect(sim.rules).toEqual(RELAXED);
  });
});

describe("hardcore", () => {
  async function hardcore() {
    const app = make();
    const id = (await post(app, "/api/simulations", { name: "H", startAt: START, preset: "hardcore" })).json().id as number;
    await app.ready();
    const msgs: any[] = [];
    const ws = await app.injectWS(`/ws/simulations/${id}`, {}, { onInit: (w: any) => w.on("message", (d: Buffer) => msgs.push(JSON.parse(String(d)))) });
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    const until = async (cond: () => boolean) => {
      const end = Date.now() + 1500;
      while (!cond()) {
        if (Date.now() > end) throw new Error("timed out: " + JSON.stringify(msgs.map((m) => m.type === "snapshot" ? ["snap", m.running] : m)));
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    return { app, id, msgs, send, until };
  }

  it("refuses a pause and a tempo change with a German notice", async () => {
    const t = await hardcore();
    t.send({ type: "run" });
    await t.until(() => t.msgs.some((m) => m.type === "snapshot" && m.running));
    t.send({ type: "pause" });
    await t.until(() => t.msgs.some((m) => m.type === "notice" && /keine Pause/.test(m.text)));
    t.send({ type: "tempo", tempo: 30 });
    await t.until(() => t.msgs.some((m) => m.type === "notice" && /Tempo festgelegt/.test(m.text)));
    expect(t.app.session.isRunning(t.id)).toBe(true);
    expect(t.app.session.snapshot(t.id).simulation.tempo).toBe(1);
  });

  it("takes orders only while the clock runs", async () => {
    const app = make();
    const id = (await post(app, "/api/simulations", { name: "H", startAt: START, preset: "hardcore" })).json().id as number;
    const depotId = app.session.defaultDepotId(id);
    const order = { symbol: SAP.symbol, side: "buy" as const, kind: "market" as const, qty: 1 };
    expect(app.session.placeOrder(id, depotId, order)).toMatchObject({ ok: false, reason: expect.stringMatching(/nur bei laufender Uhr/) });
    app.session.run(id);
    expect(app.session.placeOrder(id, depotId, order).ok).toBe(true);
  });
});

describe("maxPositions", () => {
  it("refuses a buy of one more symbol, but not more of one that is held", async () => {
    const app = make();
    const id = (await post(app, "/api/simulations", { name: "M", startAt: START, rules: { maxPositions: 1 } })).json().id as number;
    const depotId = app.session.defaultDepotId(id);
    const buy = (symbol: string) => app.session.placeOrder(id, depotId, { symbol, side: "buy", kind: "market", qty: 1 });
    expect(buy(SAP.symbol).ok).toBe(true);
    expect(buy(SAP.symbol).ok).toBe(true);
    expect(buy(AAPL.symbol)).toMatchObject({ ok: false, reason: expect.stringMatching(/höchstens 1/) });
  });
});
