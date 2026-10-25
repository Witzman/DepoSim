import { describe, expect, it } from "vitest";
import { createArchive } from "../src/data/archive.js";
import { openDb } from "../src/db.js";
import { DEFAULT_FEES } from "../src/domain/fees.js";
import { InstrumentRegistry } from "../src/instruments.js";
import { SessionService } from "../src/session.js";
import { createStore } from "../src/store.js";
import type { Instrument } from "../src/config.js";
import { D0, FX, H, SAP, bar, makeSource } from "./fakes.js";

const SIE: Instrument = { symbol: "SIE.DE", name: "Siemens", currency: "EUR", venue: "XETRA" };

async function setup(at: number) {
  const { source, all } = makeSource();
  all[SIE.symbol] = Array.from({ length: 60 }, (_, i) => bar(D0 + 7 * H + i * 60, 50 + Math.sin(i / 3) * 4 + i * 0.05));
  const db = openDb(":memory:");
  const store = createStore(db);
  const archive = createArchive(db, source, { now: () => D0 + 5 * 86400, minGapMs: 0 });
  const svc = new SessionService({ store, archive, instruments: new InstrumentRegistry(db, [SAP, SIE]), fxSymbol: FX, now: () => D0 + 5 * 86400 });
  const sim = store.createSimulation({ name: "D", startAt: D0 + 7 * H, startCash: 1_000_000, fees: DEFAULT_FEES });
  const depotId = store.listDepots(sim.id)[0].id;
  store.saveBalance(depotId, 0, new Map([[SAP.symbol, { qty: 10, cost: 1 }], [SIE.symbol, { qty: 20, cost: 1 }]]));
  for (const s of [SAP.symbol, SIE.symbol, FX]) await archive.ensureDay(s, D0);
  store.setSimulationTime(sim.id, at);
  return { svc, store, id: sim.id };
}

describe("diversification in the evaluation", () => {
  it("measures the held positions and counts only bars up to the simulation time", async () => {
    const early = await setup(D0 + 7 * H + 55 * 60);
    const d = early.svc.evaluation(early.id).depots[0].diversification!;
    expect(d.concentration.weights.map((w) => w.symbol).sort()).toEqual(["SAP.DE", "SIE.DE"]);
    expect(d.measured).not.toBeNull();
    expect(d.measured!.until).toBeLessThanOrEqual(D0 + 7 * H + 55 * 60);

    const late = await setup(D0 + 7 * H + 60 * 60);
    const later = late.svc.evaluation(late.id).depots[0].diversification!.measured!;
    expect(later.until).toBeGreaterThan(d.measured!.until);
    expect(later.n).toBeGreaterThan(d.measured!.n);
  });

  it("says there is too little to measure right at the start", async () => {
    const t = await setup(D0 + 7 * H + 5 * 60);
    const d = t.svc.evaluation(t.id).depots[0].diversification!;
    expect(d.measured).toBeNull();
    expect(d.reason).toMatch(/zu wenige gemeinsame Werte/);
  });

  it("still reports the concentration before any bar is known", async () => {
    const t = await setup(D0 + 7 * H);
    const d = t.svc.evaluation(t.id).depots[0].diversification!;
    expect(d.concentration.weights).toHaveLength(2);
    expect(d.measured).toBeNull();
  });

  it("is null for a depot without positions", async () => {
    const t = await setup(D0 + 7 * H + 55 * 60);
    t.store.saveBalance(t.store.listDepots(t.id)[0].id, 1_000_000, new Map());
    expect(t.svc.evaluation(t.id).depots[0].diversification).toBeNull();
  });
});
