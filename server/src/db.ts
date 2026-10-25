import Database from "better-sqlite3";

import { RELAXED } from "./domain/rules.js";

export type Db = Database.Database;

const RULES_DEFAULT_JSON = JSON.stringify(RELAXED);

const SCHEMA = `
create table if not exists bars (
  symbol text not null,
  t integer not null,
  o real not null,
  h real not null,
  l real not null,
  c real not null,
  v integer not null,
  primary key (symbol, t)
);
create table if not exists fetched_days (
  symbol text not null,
  day_start integer not null,
  complete integer not null,
  primary key (symbol, day_start)
);
create table if not exists daily_bars (
  symbol text not null,
  day text not null,
  o real not null,
  h real not null,
  l real not null,
  c real not null,
  v integer not null,
  primary key (symbol, day)
);
create table if not exists bar_flags (
  symbol text not null,
  t integer not null,
  kind text not null,
  detail text not null,
  primary key (symbol, t, kind)
);
create table if not exists dividends (
  symbol text not null,
  ex_day text not null,
  amount real not null,
  primary key (symbol, ex_day)
);
create table if not exists splits (
  symbol text not null,
  day text not null,
  numerator real not null,
  denominator real not null,
  primary key (symbol, day)
);
create table if not exists events_fetched (
  symbol text primary key,
  fetched_at integer not null
);
create table if not exists daily_fetched (
  symbol text primary key,
  fetched_at integer not null,
  last_day text,
  splits integer not null default 0
);
create table if not exists fx_daily (
  ccy text not null,
  day text not null,
  rate real not null,
  filled integer not null default 0,
  primary key (ccy, day)
);
create table if not exists fx_fetched (
  source text primary key,
  fetched_at integer not null
);
create table if not exists job_runs (
  id integer primary key,
  job text not null,
  trigger text not null,
  slot integer,
  started_at integer not null,
  finished_at integer,
  status text not null,
  message text,
  counts text,
  error text
);
create index if not exists job_runs_job on job_runs (job, started_at);
create table if not exists source_stats (
  hour integer not null,
  source text not null,
  kind text not null,
  count integer not null,
  ms_total integer not null,
  last_at integer not null,
  primary key (hour, source, kind)
);
create table if not exists simulations (
  id integer primary key,
  name text not null,
  start_at integer not null,
  simulation_time integer not null,
  tempo integer not null,
  start_cash integer not null,
  fees_json text not null,
  created_at integer not null,
  ended_at integer,
  live integer not null default 0,
  benchmark text,
  rules_json text not null default '${RULES_DEFAULT_JSON}'
);
create table if not exists instruments (
  symbol text primary key,
  name text not null,
  currency text not null,
  venue text not null,
  position integer not null,
  sector text,
  kind text
);
create table if not exists depots (
  id integer primary key,
  simulation_id integer not null references simulations (id) on delete cascade,
  name text not null,
  cash integer not null,
  kind text not null default 'normal'
);
create table if not exists journal_notes (
  simulation_id integer references simulations (id) on delete cascade,
  trade_key text,
  text text,
  updated_at integer,
  primary key (simulation_id, trade_key)
);
create table if not exists depot_values (
  depot_id integer not null references depots (id) on delete cascade,
  t integer not null,
  value integer not null,
  primary key (depot_id, t)
);
create table if not exists positions (
  depot_id integer not null references depots (id) on delete cascade,
  symbol text not null,
  qty integer not null,
  cost integer not null,
  primary key (depot_id, symbol)
);
create table if not exists cash_events (
  depot_id integer not null references depots (id) on delete cascade,
  t integer not null,
  kind text not null,
  symbol text not null,
  ref text not null,
  amount integer not null,
  text text not null,
  primary key (depot_id, kind, symbol, ref)
);
create table if not exists orders (
  id integer primary key,
  depot_id integer not null references depots (id) on delete cascade,
  symbol text not null,
  side text not null,
  kind text not null,
  qty integer not null,
  limit_price real,
  status text not null,
  created_sim integer not null,
  filled_sim integer,
  fill_price real,
  gross integer,
  commission integer,
  foreign_fee integer
);
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // A database made before live simulations has no `live` column. `create table if not exists`
  // leaves it as it was, so the column is added here, and the old rows become replays.
  const columns = db.prepare("pragma table_info(simulations)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "live")) {
    db.exec("alter table simulations add column live integer not null default 0");
  }
  if (!columns.some((c) => c.name === "benchmark")) db.exec("alter table simulations add column benchmark text");
  // Rules (#27): an older simulation is a relaxed one, as it always played.
  if (!columns.some((c) => c.name === "rules_json")) {
    db.exec(`alter table simulations add column rules_json text not null default '${RULES_DEFAULT_JSON}'`);
  }
  // The same for the instruments table: sector and kind came later.
  const instrumentColumns = db.prepare("pragma table_info(instruments)").all() as { name: string }[];
  for (const column of ["sector", "kind"]) {
    if (!instrumentColumns.some((c) => c.name === column)) db.exec(`alter table instruments add column ${column} text`);
  }
  // Depot kinds (normal, ghost) came with Paket E.
  const depotColumns = db.prepare("pragma table_info(depots)").all() as { name: string }[];
  if (!depotColumns.some((c) => c.name === "kind")) db.exec("alter table depots add column kind text not null default 'normal'");
  return db;
}
