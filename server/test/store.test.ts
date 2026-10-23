import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("store, depot and orders", () => {
  function setup() {
    const db = openDb(":memory:");
    const store = createStore(db);
    const sim = store.createSimulation(input);
    return { db, store, sim, depotId: store.listDepots(sim.id)[0].id };
  }

  it("round-trips cash, positions and orders through loadDepot", () => {
    const { store, depotId } = setup();
    store.saveBalance(depotId, 900_000, new Map([["A", { qty: 3, cost: 300 }]]));
    const id = store.insertOrder(depotId, { symbol: "A", side: "buy", kind: "limit", qty: 2, limitPrice: 9.5 }, 5000);
    const state = store.loadDepot(depotId);
    expect(state.cash).toBe(900_000);
    expect(state.positions.get("A")).toEqual({ qty: 3, cost: 300 });
    expect(state.orders).toEqual([
      { id, symbol: "A", side: "buy", kind: "limit", qty: 2, limitPrice: 9.5, status: "open", createdSim: 5000 },
    ]);
  });

  it("saveBalance replaces the positions instead of adding to them", () => {
    const { store, depotId } = setup();
    store.saveBalance(depotId, 1, new Map([["A", { qty: 1, cost: 1 }], ["B", { qty: 2, cost: 2 }]]));
    store.saveBalance(depotId, 1, new Map([["B", { qty: 5, cost: 5 }]]));
    expect([...store.loadDepot(depotId).positions.keys()]).toEqual(["B"]);
  });

  it("records a fill and a status change on an order", () => {
    const { store, depotId } = setup();
    const a = store.insertOrder(depotId, { symbol: "A", side: "buy", kind: "market", qty: 1 }, 5000);
    const b = store.insertOrder(depotId, { symbol: "A", side: "sell", kind: "market", qty: 1 }, 5000);
    store.markFilled(a, { filledSim: 5060, fillPrice: 10.01, gross: 1001, commission: 490, foreignFee: 0 });
    store.setOrderStatus(b, "cancelled");
    const orders = store.loadDepot(depotId).orders;
    expect(orders.find((o) => o.id === a)).toMatchObject({
      status: "filled", filledSim: 5060, fillPrice: 10.01, gross: 1001, commission: 490, foreignFee: 0,
    });
    expect(orders.find((o) => o.id === b)?.status).toBe("cancelled");
  });

  it("sets the simulation time and tempo", () => {
    const { store, sim } = setup();
    store.setSimulationTime(sim.id, 6000);
    store.setTempo(sim.id, 30);
    expect(store.getSimulation(sim.id)).toMatchObject({ simulationTime: 6000, tempo: 30 });
  });

  it("rolls everything back when the function inside a transaction throws", () => {
    const { store, sim, depotId } = setup();
    expect(() =>
      store.transaction(() => {
        store.setSimulationTime(sim.id, 9999);
        store.saveBalance(depotId, 1, new Map());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getSimulation(sim.id)?.simulationTime).toBe(5000);
    expect(store.loadDepot(depotId).cash).toBe(1_000_000);
  });
});

describe("store, live simulations", () => {
  it("a simulation is not live unless it is created as one", () => {
    const store = createStore(openDb(":memory:"));
    expect(store.createSimulation(input).live).toBe(false);
    expect(store.createSimulation({ ...input, live: true }).live).toBe(true);
    expect(store.listSimulations().map((s) => s.live)).toEqual([false, true]);
  });

  it("opens a database made before the `live` column existed, adds the column and keeps the old rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "deposim-old-"));
    try {
      const path = join(dir, "old.sqlite");
      const old = new Database(path);
      old.exec(`create table simulations (
        id integer primary key, name text not null, start_at integer not null, simulation_time integer not null,
        tempo integer not null, start_cash integer not null, fees_json text not null, created_at integer not null, ended_at integer);
        insert into simulations values (1, 'alt', 100, 100, 1, 1000000, '{}', 1, null);`);
      old.close();

      const db = openDb(path);
      const columns = (db.prepare("pragma table_info(simulations)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).toContain("live");
      expect(createStore(db).getSimulation(1)).toMatchObject({ name: "alt", live: false });
      db.close();
      openDb(path).close(); // opening it again does not fail on the column that is there now
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
