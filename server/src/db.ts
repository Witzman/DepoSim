import Database from "better-sqlite3";

export type Db = Database.Database;

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
  live integer not null default 0
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
  cash integer not null
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
  // The same for the instruments table: sector and kind came later.
  const instrumentColumns = db.prepare("pragma table_info(instruments)").all() as { name: string }[];
  for (const column of ["sector", "kind"]) {
    if (!instrumentColumns.some((c) => c.name === column)) db.exec(`alter table instruments add column ${column} text`);
  }
  return db;
}
