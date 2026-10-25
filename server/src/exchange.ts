import { z } from "zod";
import type { Db } from "./db.js";
import { RELAXED } from "./domain/rules.js";
import { parseAutoPause } from "./domain/autopause.js";
import { scenarioById } from "./domain/scenario.js";
import { parseTaxSettings } from "./domain/tax.js";

export const FORMAT = "deposim-simulation";
export const VERSION = 1;

export class ExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExchangeError";
  }
}

const int = z.number().int();
const orderShape = z.object({
  id: int,
  symbol: z.string().min(1).max(20),
  side: z.enum(["buy", "sell"]),
  kind: z.enum(["market", "limit"]),
  qty: int,
  limitPrice: z.number().nullable(),
  status: z.enum(["open", "filled", "cancelled", "rejected"]),
  createdSim: int,
  filledSim: int.nullable(),
  fillPrice: z.number().nullable(),
  gross: int.nullable(),
  commission: int.nullable(),
  foreignFee: int.nullable(),
});

const fileShape = z.object({
  format: z.literal(FORMAT),
  version: z.literal(VERSION),
  exportedAt: int,
  simulation: z.object({
    name: z.string().trim().min(1).max(80),
    startAt: int,
    simulationTime: int,
    tempo: int,
    startCash: int,
    fees: z.record(z.string(), z.unknown()),
    createdAt: int,
    endedAt: int.nullable(),
    live: z.boolean(),
    benchmark: z.string().nullable(),
    // Added after version 1 shipped (#27, #54): files without them are minute simulations with the relaxed rules.
    resolution: z.enum(["minute", "day"]).optional(),
    rules: z.record(z.string(), z.unknown()).optional(),
    // Added later still (the scenario, the end of it, the auto-pause and tax settings): a file without them has none.
    scenarioId: z.string().nullable().optional(),
    endAt: int.nullable().optional(),
    autoPause: z.unknown().optional(),
    tax: z.unknown().optional(),
  }),
  depots: z.array(z.object({
    name: z.string().min(1).max(40),
    cash: int,
    kind: z.enum(["normal", "ghost"]),
    positions: z.array(z.object({ symbol: z.string().min(1), qty: int, cost: int })),
    orders: z.array(orderShape),
    bookings: z.array(z.object({ t: int, kind: z.enum(["dividend", "split"]), symbol: z.string().min(1), ref: z.string(), amount: int, text: z.string() })).optional(),
    values: z.array(z.object({ t: int, value: int })),
  })).min(1).max(20),
  notes: z.array(z.object({ tradeKey: z.string().regex(/^\d{1,12}:\d{1,12}$/), text: z.string().max(500), updatedAt: int })),
});

export type SimulationFile = z.infer<typeof fileShape>;

interface SimRow {
  id: number; name: string; start_at: number; simulation_time: number; tempo: number; start_cash: number;
  fees_json: string; created_at: number; ended_at: number | null; live: number; benchmark: string | null; rules_json: string; resolution: string;
  scenario_id: string | null; end_at: number | null; auto_pause: string | null; tax: string | null;
}
interface OrderRow {
  id: number; symbol: string; side: string; kind: string; qty: number; limit_price: number | null; status: string;
  created_sim: number; filled_sim: number | null; fill_price: number | null; gross: number | null;
  commission: number | null; foreign_fee: number | null;
}

/** One simulation with everything that is its own: settings, depots, orders, positions, curves and notes. */
export function exportSimulation(db: Db, id: number, now: number): SimulationFile {
  const sim = db.prepare("select * from simulations where id = ?").get(id) as SimRow | undefined;
  if (!sim) throw new ExchangeError("Unbekannte Simulation.");
  const depots = db.prepare("select id, name, cash, kind from depots where simulation_id = ? order by id").all(id) as {
    id: number; name: string; cash: number; kind: "normal" | "ghost";
  }[];
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Math.floor(now),
    simulation: {
      name: sim.name, startAt: sim.start_at, simulationTime: sim.simulation_time, tempo: sim.tempo, startCash: sim.start_cash,
      fees: JSON.parse(sim.fees_json) as Record<string, unknown>, createdAt: sim.created_at, endedAt: sim.ended_at,
      live: sim.live === 1, benchmark: sim.benchmark, resolution: sim.resolution === "day" ? "day" : "minute",
      rules: JSON.parse(sim.rules_json) as Record<string, unknown>,
      scenarioId: sim.scenario_id, endAt: sim.end_at,
      autoPause: sim.auto_pause === null ? null : JSON.parse(sim.auto_pause), tax: sim.tax === null ? null : JSON.parse(sim.tax),
    },
    depots: depots.map((d) => ({
      name: d.name, cash: d.cash, kind: d.kind,
      positions: db.prepare("select symbol, qty, cost from positions where depot_id = ? order by symbol").all(d.id) as {
        symbol: string; qty: number; cost: number;
      }[],
      orders: (db.prepare("select * from orders where depot_id = ? order by id").all(d.id) as OrderRow[]).map((o) => ({
        id: o.id, symbol: o.symbol, side: o.side as "buy", kind: o.kind as "market", qty: o.qty, limitPrice: o.limit_price,
        status: o.status as "open", createdSim: o.created_sim, filledSim: o.filled_sim, fillPrice: o.fill_price, gross: o.gross,
        commission: o.commission, foreignFee: o.foreign_fee,
      })),
      bookings: db.prepare("select t, kind, symbol, ref, amount, text from cash_events where depot_id = ? order by t, symbol").all(d.id) as {
        t: number; kind: "dividend" | "split"; symbol: string; ref: string; amount: number; text: string;
      }[],
      values: db.prepare("select t, value from depot_values where depot_id = ? order by t").all(d.id) as { t: number; value: number }[],
    })),
    notes: (db.prepare("select trade_key, text, updated_at from journal_notes where simulation_id = ?").all(id) as {
      trade_key: string; text: string; updated_at: number;
    }[]).map((n) => ({ tradeKey: n.trade_key, text: n.text, updatedAt: n.updated_at })),
  };
}

/** The name, or the name with " (Import)", " (Import 2)", ... when a simulation of that name exists. */
function freeName(db: Db, name: string): string {
  const taken = new Set((db.prepare("select name from simulations").all() as { name: string }[]).map((r) => r.name));
  if (!taken.has(name)) return name;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (Import)" : ` (Import ${n})`;
    const candidate = name.slice(0, 80 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Checks the text without touching anything: the version first, so a newer file gets a clear message. */
export function parseSimulationFile(raw: unknown): SimulationFile {
  if (typeof raw !== "object" || raw === null || (raw as { format?: unknown }).format !== FORMAT) {
    throw new ExchangeError("Das ist keine Simulationsdatei von DepoSim.");
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== VERSION) {
    throw new ExchangeError(`Unbekannte Schemaversion ${JSON.stringify(version)} der Datei. Diese Version von DepoSim liest nur Version ${VERSION}.`);
  }
  const parsed = fileShape.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ExchangeError(`Die Simulationsdatei ist unvollständig oder beschädigt (${issue.path.join(".") || "Datei"}: ${issue.message}).`);
  }
  return parsed.data;
}

/**
 * Creates a new simulation from a file: new ids everywhere, the references rewritten, one transaction.
 * `known` says which symbols this instance can trade; a file with others is refused whole.
 */
export function importSimulation(db: Db, raw: unknown, known: (symbol: string) => boolean, now: number): { id: number; name: string } {
  const file = parseSimulationFile(raw);
  const symbols = new Set(file.depots.flatMap((d) => [...d.positions.map((p) => p.symbol), ...d.orders.map((o) => o.symbol)]));
  if (file.simulation.benchmark) symbols.add(file.simulation.benchmark);
  const unknown = [...symbols].filter((s) => !known(s));
  if (unknown.length > 0) {
    throw new ExchangeError(`Die Datei enthält Wertpapiere, die diese Instanz nicht kennt: ${unknown.join(", ")}. Zuerst zur Watchlist hinzufügen.`);
  }
  return db.transaction(() => {
    const s = file.simulation;
    const name = freeName(db, s.name);
    const id = Number(
      db.prepare(
        "insert into simulations (name, start_at, simulation_time, tempo, start_cash, fees_json, created_at, ended_at, live, benchmark, rules_json, resolution, scenario_id, end_at, auto_pause, tax) " +
          "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(name, s.startAt, s.simulationTime, s.tempo, s.startCash, JSON.stringify(s.fees), Math.floor(now), s.endedAt, s.live ? 1 : 0, s.benchmark,
        JSON.stringify(s.rules ?? RELAXED), s.resolution ?? "minute",
        // A scenario this version does not know cannot be judged: the round then plays as a free one.
        s.scenarioId && scenarioById(s.scenarioId) ? s.scenarioId : null, s.scenarioId && scenarioById(s.scenarioId) ? s.endAt ?? null : null,
        s.autoPause == null ? null : JSON.stringify(parseAutoPause(s.autoPause)), s.tax == null ? null : JSON.stringify(parseTaxSettings(s.tax)))
        .lastInsertRowid,
    );
    const orderIds = new Map<number, number>();
    for (const d of file.depots) {
      const depotId = Number(
        db.prepare("insert into depots (simulation_id, name, cash, kind) values (?, ?, ?, ?)").run(id, d.name, d.cash, d.kind).lastInsertRowid,
      );
      for (const p of d.positions) db.prepare("insert into positions (depot_id, symbol, qty, cost) values (?, ?, ?, ?)").run(depotId, p.symbol, p.qty, p.cost);
      for (const b of d.bookings ?? []) {
        db.prepare("insert or ignore into cash_events (depot_id, t, kind, symbol, ref, amount, text) values (?, ?, ?, ?, ?, ?, ?)").run(depotId, b.t, b.kind, b.symbol, b.ref, b.amount, b.text);
      }
      for (const v of d.values) db.prepare("insert or replace into depot_values (depot_id, t, value) values (?, ?, ?)").run(depotId, v.t, v.value);
      for (const o of d.orders) {
        const newId = Number(
          db.prepare(
            "insert into orders (depot_id, symbol, side, kind, qty, limit_price, status, created_sim, filled_sim, fill_price, gross, commission, foreign_fee) " +
              "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(depotId, o.symbol, o.side, o.kind, o.qty, o.limitPrice, o.status, o.createdSim, o.filledSim, o.fillPrice, o.gross, o.commission, o.foreignFee)
            .lastInsertRowid,
        );
        orderIds.set(o.id, newId);
      }
    }
    // A trade key is "sellOrderId:buyOrderId": it follows the orders to their new ids. A note whose orders are not in the file is dropped.
    for (const n of file.notes) {
      const [sell, buy] = n.tradeKey.split(":").map(Number);
      const a = orderIds.get(sell);
      const b = orderIds.get(buy);
      if (a === undefined || b === undefined) continue;
      db.prepare("insert or replace into journal_notes (simulation_id, trade_key, text, updated_at) values (?, ?, ?, ?)").run(id, `${a}:${b}`, n.text, n.updatedAt);
    }
    return { id, name };
  })();
}

// ---- CSV: semicolon, decimal comma, UTF-8 with BOM, so that German Excel opens it ----

export const BOM = "﻿";

/** A text cell: quoted if needed, and defanged if Excel would read it as a formula. */
function text(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const euro = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(".", ","));
const price = (v: number | null) => (v === null ? "" : String(v).replace(".", ","));
const when = (s: number | null) => (s === null ? "" : new Date(s * 1000).toISOString().slice(0, 19).replace("T", " "));

function csv(header: string[], rows: string[][]): string {
  return BOM + [header, ...rows].map((r) => r.join(";")).join("\r\n") + "\r\n";
}

export function ordersCsv(db: Db, id: number): string {
  const rows = db.prepare(
    "select o.*, d.name as depot from orders o join depots d on d.id = o.depot_id where d.simulation_id = ? order by d.id, o.id",
  ).all(id) as (OrderRow & { depot: string })[];
  return csv(
    ["Depot", "Auftrag", "Wertpapier", "Seite", "Art", "Menge", "Limit", "Status", "Erteilt (UTC)", "Ausgeführt (UTC)", "Kurs", "Brutto", "Provision", "Fremdwährungsentgelt"],
    rows.map((o) => [
      text(o.depot), String(o.id), text(o.symbol), o.side === "buy" ? "Kauf" : "Verkauf", o.kind === "market" ? "Markt" : "Limit",
      String(o.qty), price(o.limit_price),
      { open: "offen", filled: "ausgeführt", cancelled: "gelöscht", rejected: "abgelehnt" }[o.status] ?? o.status,
      when(o.created_sim), when(o.filled_sim), price(o.fill_price), euro(o.gross), euro(o.commission), euro(o.foreign_fee),
    ]),
  );
}

export function valuesCsv(db: Db, id: number): string {
  const rows = db.prepare(
    "select d.name as depot, v.t, v.value from depot_values v join depots d on d.id = v.depot_id where d.simulation_id = ? order by d.id, v.t",
  ).all(id) as { depot: string; t: number; value: number }[];
  return csv(["Depot", "Zeit (UTC)", "Depotwert"], rows.map((r) => [text(r.depot), when(r.t), euro(r.value)]));
}

/** Minute or day bars of one symbol in a period, to take along. */
export function barsCsv(db: Db, symbol: string, kind: "minute" | "day", from: number, to: number): string {
  if (kind === "minute") {
    const rows = db.prepare("select t, o, h, l, c, v from bars where symbol = ? and t >= ? and t < ? order by t").all(symbol, from, to) as {
      t: number; o: number; h: number; l: number; c: number; v: number;
    }[];
    return csv(["Zeit (UTC)", "Eröffnung", "Hoch", "Tief", "Schluss", "Volumen"],
      rows.map((r) => [when(r.t), price(r.o), price(r.h), price(r.l), price(r.c), String(r.v)]));
  }
  const rows = db.prepare("select day, o, h, l, c, v from daily_bars where symbol = ? and day >= ? and day < ? order by day").all(
    symbol, new Date(from * 1000).toISOString().slice(0, 10), new Date(to * 1000).toISOString().slice(0, 10),
  ) as { day: string; o: number; h: number; l: number; c: number; v: number }[];
  return csv(["Tag", "Eröffnung", "Hoch", "Tief", "Schluss", "Volumen"],
    rows.map((r) => [r.day, price(r.o), price(r.h), price(r.l), price(r.c), String(r.v)]));
}
