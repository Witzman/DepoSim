import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DEFAULT_FEES } from "../src/domain/fees.js";
import { createStore } from "../src/store.js";

const input = { name: "Test", startAt: 5000, startCash: 1_000_000, fees: DEFAULT_FEES };

describe("store", () => {
  it("creates a simulation with exactly one depot holding the start cash", () => {
    const store = createStore(openDb(":memory:"));
    const sim = store.createSimulation(input);
    expect(sim).toMatchObject({
      name: "Test", startAt: 5000, simulationTime: 5000, tempo: 1, startCash: 1_000_000, endedAt: null,
    });
    expect(sim.fees).toEqual(DEFAULT_FEES);
    const depots = store.listDepots(sim.id);
    expect(depots).toHaveLength(1);
    expect(depots[0]).toMatchObject({ simulationId: sim.id, cash: 1_000_000 });
  });

  it("reads a simulation back and lists them oldest first", () => {
    const store = createStore(openDb(":memory:"));
    const a = store.createSimulation(input);
    const b = store.createSimulation({ ...input, name: "Second" });
    expect(store.getSimulation(a.id)).toEqual(a);
    expect(store.listSimulations().map((s) => s.id)).toEqual([a.id, b.id]);
    expect(store.getSimulation(9999)).toBeUndefined();
  });

  it("ends a simulation by stamping the end time", () => {
    const store = createStore(openDb(":memory:"), { now: () => 777 });
    const sim = store.createSimulation(input);
    store.endSimulation(sim.id);
    expect(store.getSimulation(sim.id)?.endedAt).toBe(777);
  });

  it("deletes the depots, positions and orders with the simulation", () => {
    const db = openDb(":memory:");
    const store = createStore(db);
    const sim = store.createSimulation(input);
    const other = store.createSimulation({ ...input, name: "Other" });
    const depotId = store.listDepots(sim.id)[0].id;
    db.prepare("insert into positions (depot_id, symbol, qty, cost) values (?, 'A', 3, 300)").run(depotId);
    db.prepare(
      "insert into orders (depot_id, symbol, side, kind, qty, status, created_sim) values (?, 'A', 'buy', 'market', 3, 'open', 5000)",
    ).run(depotId);

    store.deleteSimulation(sim.id);

    const count = (table: string) => (db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
    expect(store.getSimulation(sim.id)).toBeUndefined();
    expect(count("positions")).toBe(0);
    expect(count("orders")).toBe(0);
    expect(count("depots")).toBe(1);
    expect(store.getSimulation(other.id)).toBeDefined();
  });
});
