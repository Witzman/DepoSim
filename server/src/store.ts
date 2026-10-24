import type { Db } from "./db.js";
import type { Cent } from "./domain/money.js";
import type { FeeConfig } from "./domain/fees.js";
import type { Tempo } from "./domain/clock.js";
import type { DepotState, NewOrder, Order, OrderStatus } from "./domain/broker.js";

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
  /** A live simulation catches up to the present by itself and then follows real time. */
  live: boolean;
  /** The symbol its curves are measured against, if the person chose one. */
  benchmark: string | null;
}

/** A ghost is a frozen copy of a depot that never trades; it is only valued at market. */
export type DepotKind = "normal" | "ghost";

export interface Depot {
  id: number;
  simulationId: number;
  name: string;
  cash: Cent;
  kind: DepotKind;
}

export interface NewSimulation {
  name: string;
  startAt: number;
  startCash: Cent;
  fees: FeeConfig;
  live?: boolean;
}

/** An order as stored: the order itself plus when it was placed and how it filled. */
export interface OrderRecord extends Order {
  createdSim: number;
  filledSim?: number;
  fillPrice?: number;
  gross?: Cent;
  commission?: Cent;
  foreignFee?: Cent;
}

export interface Fill {
  filledSim: number;
  fillPrice: number;
  gross: Cent;
  commission: Cent;
  foreignFee: Cent;
}

export interface Store {
  createSimulation(input: NewSimulation): Simulation;
  getSimulation(id: number): Simulation | undefined;
  listSimulations(): Simulation[];
  endSimulation(id: number): void;
  deleteSimulation(id: number): void;
  listDepots(simulationId: number): Depot[];
  /** A depot with the simulation's start cash; its curve starts at the simulation time. */
  createDepot(simulationId: number, name: string): Depot;
  /**
   * A ghost depot with the given cash and positions; its curve starts at `t` with `value`.
   * The orders of the source are not copied.
   */
  createGhostDepot(
    simulationId: number, name: string, cash: Cent, positions: DepotState["positions"], t: number, value: Cent,
  ): Depot;
  /** The journal notes of a simulation, by trade key. */
  notes(simulationId: number): Record<string, string>;
  /** Stores a note for a trade; empty text deletes it. */
  setNote(simulationId: number, tradeKey: string, text: string, at: number): void;
  /** Takes the positions, orders and curve of the depot with it. */
  deleteDepot(depotId: number): void;
  renameDepot(depotId: number, name: string): void;
  /** One point of a depot's value over time; a second write for the same time replaces the first. */
  recordValue(depotId: number, t: number, value: Cent): void;
  /** The points in time order, thinned to `maxPoints` (last value per interval, first point kept). */
  valueCurve(depotId: number, maxPoints?: number): { t: number; value: Cent }[];
  setSimulationTime(id: number, simulationTime: number): void;
  setTempo(id: number, tempo: Tempo): void;
  setBenchmark(id: number, symbol: string | null): void;
  /** Cash, positions and every order of one depot. */
  loadDepot(depotId: number): DepotState & { orders: OrderRecord[] };
  /** Writes the cash and replaces the positions. */
  saveBalance(depotId: number, cash: Cent, positions: DepotState["positions"]): void;
  insertOrder(depotId: number, o: NewOrder, createdSim: number): number;
  markFilled(orderId: number, fill: Fill): void;
  setOrderStatus(orderId: number, status: OrderStatus): void;
  /** True if any simulation holds the symbol or has an open order in it. */
  symbolInUse(symbol: string): boolean;
  /** Everything inside commits together or not at all. */
  transaction<T>(fn: () => T): T;
}

interface OrderRow {
  id: number;
  symbol: string;
  side: Order["side"];
  kind: Order["kind"];
  qty: number;
  limit_price: number | null;
  status: OrderStatus;
  created_sim: number;
  filled_sim: number | null;
  fill_price: number | null;
  gross: number | null;
  commission: number | null;
  foreign_fee: number | null;
}

const toOrder = (r: OrderRow): OrderRecord => ({
  id: r.id,
  symbol: r.symbol,
  side: r.side,
  kind: r.kind,
  qty: r.qty,
  limitPrice: r.limit_price ?? undefined,
  status: r.status,
  createdSim: r.created_sim,
  filledSim: r.filled_sim ?? undefined,
  fillPrice: r.fill_price ?? undefined,
  gross: r.gross ?? undefined,
  commission: r.commission ?? undefined,
  foreignFee: r.foreign_fee ?? undefined,
});

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
  live: number;
  benchmark: string | null;
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
  live: r.live === 1,
  benchmark: r.benchmark,
});

export function createStore(db: Db, opts: { now?: () => number } = {}): Store {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const insertSimulation = db.prepare(
    "insert into simulations (name, start_at, simulation_time, tempo, start_cash, fees_json, created_at, live) " +
      "values (?, ?, ?, 1, ?, ?, ?, ?)",
  );
  const insertDepot = db.prepare("insert into depots (simulation_id, name, cash) values (?, 'Depot 1', ?)");
  const recordPoint = db.prepare("insert or replace into depot_values (depot_id, t, value) values (?, ?, ?)");
  const selectOne = db.prepare("select * from simulations where id = ?");
  const create = db.transaction((input: NewSimulation) => {
    const id = Number(
      insertSimulation.run(
        input.name, input.startAt, input.startAt, input.startCash, JSON.stringify(input.fees), now(), input.live ? 1 : 0,
      ).lastInsertRowid,
    );
    const depotId = Number(insertDepot.run(id, input.startCash).lastInsertRowid);
    recordPoint.run(depotId, input.startAt, input.startCash);
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
    setSimulationTime: (id, simulationTime) => {
      db.prepare("update simulations set simulation_time = ? where id = ?").run(simulationTime, id);
    },
    setBenchmark: (id, symbol) => {
      db.prepare("update simulations set benchmark = ? where id = ?").run(symbol, id);
    },
    setTempo: (id, tempo) => {
      db.prepare("update simulations set tempo = ? where id = ?").run(tempo, id);
    },
    loadDepot: (depotId) => {
      const cash = (db.prepare("select cash from depots where id = ?").get(depotId) as { cash: number }).cash;
      const positions = new Map<string, { qty: number; cost: Cent }>();
      for (const r of db.prepare("select symbol, qty, cost from positions where depot_id = ?").all(depotId) as {
        symbol: string; qty: number; cost: number;
      }[]) {
        positions.set(r.symbol, { qty: r.qty, cost: r.cost });
      }
      const orders = (db.prepare("select * from orders where depot_id = ? order by id").all(depotId) as OrderRow[]).map(toOrder);
      return { cash, positions, orders };
    },
    saveBalance: (depotId, cash, positions) => {
      db.transaction(() => {
        db.prepare("update depots set cash = ? where id = ?").run(cash, depotId);
        db.prepare("delete from positions where depot_id = ?").run(depotId);
        const insert = db.prepare("insert into positions (depot_id, symbol, qty, cost) values (?, ?, ?, ?)");
        for (const [symbol, pos] of positions) insert.run(depotId, symbol, pos.qty, pos.cost);
      })();
    },
    insertOrder: (depotId, o, createdSim) =>
      Number(
        db
          .prepare(
            "insert into orders (depot_id, symbol, side, kind, qty, limit_price, status, created_sim) " +
              "values (?, ?, ?, ?, ?, ?, 'open', ?)",
          )
          .run(depotId, o.symbol, o.side, o.kind, o.qty, o.limitPrice ?? null, createdSim).lastInsertRowid,
      ),
    markFilled: (orderId, f) => {
      db.prepare(
        "update orders set status = 'filled', filled_sim = ?, fill_price = ?, gross = ?, commission = ?, foreign_fee = ? where id = ?",
      ).run(f.filledSim, f.fillPrice, f.gross, f.commission, f.foreignFee, orderId);
    },
    setOrderStatus: (orderId, status) => {
      db.prepare("update orders set status = ? where id = ?").run(status, orderId);
    },
    symbolInUse: (symbol) =>
      db
        .prepare(
          "select 1 from positions where symbol = ? and qty > 0 union all " +
            "select 1 from orders where symbol = ? and status = 'open' limit 1",
        )
        .get(symbol, symbol) !== undefined,
    transaction: (fn) => db.transaction(fn)(),
    createDepot: (simulationId, name) =>
      db.transaction((): Depot => {
        const sim = getSimulation(simulationId)!;
        const id = Number(
          db.prepare("insert into depots (simulation_id, name, cash) values (?, ?, ?)").run(simulationId, name, sim.startCash)
            .lastInsertRowid,
        );
        recordPoint.run(id, sim.simulationTime, sim.startCash);
        return { id, simulationId, name, cash: sim.startCash, kind: "normal" };
      })(),
    createGhostDepot: (simulationId, name, cash, positions, t, value) =>
      db.transaction((): Depot => {
        const id = Number(
          db.prepare("insert into depots (simulation_id, name, cash, kind) values (?, ?, ?, 'ghost')").run(simulationId, name, cash)
            .lastInsertRowid,
        );
        const insert = db.prepare("insert into positions (depot_id, symbol, qty, cost) values (?, ?, ?, ?)");
        for (const [symbol, pos] of positions) insert.run(id, symbol, pos.qty, pos.cost);
        recordPoint.run(id, t, value);
        return { id, simulationId, name, cash, kind: "ghost" };
      })(),
    notes: (simulationId) =>
      Object.fromEntries(
        (db.prepare("select trade_key, text from journal_notes where simulation_id = ?").all(simulationId) as {
          trade_key: string; text: string;
        }[]).map((r) => [r.trade_key, r.text]),
      ),
    setNote: (simulationId, tradeKey, text, at) => {
      if (text === "") {
        db.prepare("delete from journal_notes where simulation_id = ? and trade_key = ?").run(simulationId, tradeKey);
        return;
      }
      db.prepare("insert or replace into journal_notes (simulation_id, trade_key, text, updated_at) values (?, ?, ?, ?)")
        .run(simulationId, tradeKey, text, at);
    },
    deleteDepot: (depotId) => {
      db.prepare("delete from depots where id = ?").run(depotId);
    },
    renameDepot: (depotId, name) => {
      db.prepare("update depots set name = ? where id = ?").run(name, depotId);
    },
    recordValue: (depotId, t, value) => {
      recordPoint.run(depotId, t, value);
    },
    valueCurve: (depotId, maxPoints = 800) => {
      const rows = db.prepare("select t, value from depot_values where depot_id = ? order by t").all(depotId) as {
        t: number; value: number;
      }[];
      if (rows.length <= maxPoints) return rows;
      // Every `step`-th point from the end backwards, so the last point is always kept; the first is added back.
      const step = Math.ceil((rows.length - 1) / (maxPoints - 1));
      const out: { t: number; value: number }[] = [];
      for (let i = rows.length - 1; i > 0; i -= step) out.push(rows[i]);
      out.push(rows[0]);
      return out.reverse();
    },
    listDepots: (simulationId) =>
      (db.prepare("select id, simulation_id, name, cash, kind from depots where simulation_id = ? order by id")
        .all(simulationId) as { id: number; simulation_id: number; name: string; cash: number; kind: DepotKind }[]).map((r) => ({
        id: r.id,
        simulationId: r.simulation_id,
        name: r.name,
        cash: r.cash,
        kind: r.kind,
      })),
  };
}
