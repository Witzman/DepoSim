import type { Db } from "./db.js";
import type { Cent } from "./domain/money.js";
import type { FeeConfig } from "./domain/fees.js";
import type { Tempo } from "./domain/clock.js";

export interface Simulation {
  id: number;
  name: string;
  startAt: number;
  simulationTime: number;
  tempo: Tempo;
  startCash: Cent;
  fees: FeeConfig;
  createdAt: number;
  endedAt: number | null;
}

export interface Depot {
  id: number;
  simulationId: number;
  name: string;
  cash: Cent;
}

export interface NewSimulation {
  name: string;
  startAt: number;
  startCash: Cent;
  fees: FeeConfig;
}

export interface Store {
  createSimulation(input: NewSimulation): Simulation;
  getSimulation(id: number): Simulation | undefined;
  listSimulations(): Simulation[];
  endSimulation(id: number): void;
  deleteSimulation(id: number): void;
  listDepots(simulationId: number): Depot[];
}

interface SimulationRow {
  id: number;
  name: string;
  start_at: number;
  simulation_time: number;
  tempo: number;
  start_cash: number;
  fees_json: string;
  created_at: number;
  ended_at: number | null;
}

const toSimulation = (r: SimulationRow): Simulation => ({
  id: r.id,
  name: r.name,
  startAt: r.start_at,
  simulationTime: r.simulation_time,
  tempo: r.tempo as Tempo,
  startCash: r.start_cash,
  fees: JSON.parse(r.fees_json) as FeeConfig,
  createdAt: r.created_at,
  endedAt: r.ended_at,
});

export function createStore(db: Db, opts: { now?: () => number } = {}): Store {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const insertSimulation = db.prepare(
    "insert into simulations (name, start_at, simulation_time, tempo, start_cash, fees_json, created_at) " +
      "values (?, ?, ?, 1, ?, ?, ?)",
  );
  const insertDepot = db.prepare("insert into depots (simulation_id, name, cash) values (?, 'Depot 1', ?)");
  const selectOne = db.prepare("select * from simulations where id = ?");
  const create = db.transaction((input: NewSimulation) => {
    const id = Number(
      insertSimulation.run(input.name, input.startAt, input.startAt, input.startCash, JSON.stringify(input.fees), now())
        .lastInsertRowid,
    );
    insertDepot.run(id, input.startCash);
    return id;
  });

  const getSimulation = (id: number) => {
    const row = selectOne.get(id) as SimulationRow | undefined;
    return row ? toSimulation(row) : undefined;
  };

  return {
    createSimulation: (input) => getSimulation(create(input))!,
    getSimulation,
    listSimulations: () =>
      (db.prepare("select * from simulations order by id").all() as SimulationRow[]).map(toSimulation),
    endSimulation: (id) => {
      db.prepare("update simulations set ended_at = ? where id = ?").run(now(), id);
    },
    deleteSimulation: (id) => {
      db.prepare("delete from simulations where id = ?").run(id);
    },
    listDepots: (simulationId) =>
      (db.prepare("select id, simulation_id, name, cash from depots where simulation_id = ? order by id")
        .all(simulationId) as { id: number; simulation_id: number; name: string; cash: number }[]).map((r) => ({
        id: r.id,
        simulationId: r.simulation_id,
        name: r.name,
        cash: r.cash,
      })),
  };
}
