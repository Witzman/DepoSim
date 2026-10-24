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

  it("knows whether any simulation holds a symbol or has an open order in it", () => {
    const store = createStore(openDb(":memory:"));
    const sim = store.createSimulation(input);
    const depot = store.listDepots(sim.id)[0];
    expect(store.symbolInUse("AAPL")).toBe(false);

    store.saveBalance(depot.id, depot.cash, new Map([["AAPL", { qty: 3, cost: 900 }]]));
    expect(store.symbolInUse("AAPL")).toBe(true);
    expect(store.symbolInUse("SAP.DE")).toBe(false);
    store.saveBalance(depot.id, depot.cash, new Map());
    expect(store.symbolInUse("AAPL")).toBe(false);

    const orderId = store.insertOrder(depot.id, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 10 }, 5000);
    expect(store.symbolInUse("SAP.DE")).toBe(true);
    store.setOrderStatus(orderId, "cancelled");
    expect(store.symbolInUse("SAP.DE")).toBe(false);
  });

  describe("depots and value curve", () => {
    const count = (db: ReturnType<typeof openDb>, table: string) =>
      (db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;

    it("starts the first depot's curve at the start of the simulation", () => {
      const store = createStore(openDb(":memory:"));
      const sim = store.createSimulation(input);
      expect(store.valueCurve(store.listDepots(sim.id)[0].id)).toEqual([{ t: 5000, value: 1_000_000 }]);
    });

    it("creates a depot with the start cash and a start point at the simulation time", () => {
      const store = createStore(openDb(":memory:"));
      const sim = store.createSimulation(input);
      store.setSimulationTime(sim.id, 9000);
      const depot = store.createDepot(sim.id, "Zweit");
      expect(depot).toMatchObject({ simulationId: sim.id, name: "Zweit", cash: 1_000_000 });
      expect(store.listDepots(sim.id).map((d) => d.name)).toEqual(["Depot 1", "Zweit"]);
      expect(store.valueCurve(depot.id)).toEqual([{ t: 9000, value: 1_000_000 }]);
    });

    it("renames a depot", () => {
      const store = createStore(openDb(":memory:"));
      const sim = store.createSimulation(input);
      const id = store.listDepots(sim.id)[0].id;
      store.renameDepot(id, "Wachstum");
      expect(store.listDepots(sim.id)[0].name).toBe("Wachstum");
    });

    it("deletes a depot with its positions, orders and curve, and only that depot", () => {
      const db = openDb(":memory:");
      const store = createStore(db);
      const sim = store.createSimulation(input);
      const keep = store.listDepots(sim.id)[0].id;
      const drop = store.createDepot(sim.id, "Weg").id;
      for (const id of [keep, drop]) {
        db.prepare("insert into positions (depot_id, symbol, qty, cost) values (?, 'A', 1, 100)").run(id);
        db.prepare(
          "insert into orders (depot_id, symbol, side, kind, qty, status, created_sim) values (?, 'A', 'buy', 'market', 1, 'open', 5000)",
        ).run(id);
      }
      store.deleteDepot(drop);
      expect(store.listDepots(sim.id).map((d) => d.id)).toEqual([keep]);
      expect(count(db, "positions")).toBe(1);
      expect(count(db, "orders")).toBe(1);
      expect(count(db, "depot_values")).toBe(1);
    });

    it("replaces a point written twice for the same time", () => {
      const store = createStore(openDb(":memory:"));
      const sim = store.createSimulation(input);
      const id = store.listDepots(sim.id)[0].id;
      store.recordValue(id, 6000, 990_000);
      store.recordValue(id, 6000, 995_000);
      expect(store.valueCurve(id)).toEqual([{ t: 5000, value: 1_000_000 }, { t: 6000, value: 995_000 }]);
    });

    it("thins a long curve to the limit and keeps the first and the last point", () => {
      const store = createStore(openDb(":memory:"));
      const sim = store.createSimulation(input);
      const id = store.listDepots(sim.id)[0].id;
      for (let k = 1; k < 2000; k++) store.recordValue(id, 5000 + k * 60, 1_000_000 + k);
      const curve = store.valueCurve(id, 800);
      expect(curve.length).toBeLessThanOrEqual(800);
      expect(curve[0]).toEqual({ t: 5000, value: 1_000_000 });
      expect(curve[curve.length - 1]).toEqual({ t: 5000 + 1999 * 60, value: 1_000_000 + 1999 });
      expect(curve.every((p, i) => i === 0 || p.t > curve[i - 1].t)).toBe(true);
    });
  });

  it("keeps a benchmark per simulation, none at first, and clears it", () => {
    const store = createStore(openDb(":memory:"));
    const sim = store.createSimulation(input);
    expect(sim.benchmark).toBeNull();
    store.setBenchmark(sim.id, "EUNL.DE");
    expect(store.getSimulation(sim.id)?.benchmark).toBe("EUNL.DE");
    store.setBenchmark(sim.id, null);
    expect(store.getSimulation(sim.id)?.benchmark).toBeNull();
  });

  it("opens a database whose simulations have no benchmark column", () => {
    const dir = mkdtempSync(join(tmpdir(), "deposim-"));
    try {
      const path = join(dir, "old.sqlite");
      const old = new Database(path);
      old.exec(
        "create table simulations (id integer primary key, name text not null, start_at integer not null, simulation_time integer not null, " +
          "tempo integer not null, start_cash integer not null, fees_json text not null, created_at integer not null, ended_at integer, live integer not null default 0);" +
          `insert into simulations (name, start_at, simulation_time, tempo, start_cash, fees_json, created_at) values ('Alt', 1, 1, 1, 100, '${JSON.stringify(DEFAULT_FEES)}', 1);`,
      );
      old.close();
      const db = openDb(path);
      expect(createStore(db).listSimulations()[0]).toMatchObject({ name: "Alt", benchmark: null });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
