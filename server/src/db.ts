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
  ended_at integer
);
create table if not exists depots (
  id integer primary key,
  simulation_id integer not null references simulations (id) on delete cascade,
  name text not null,
  cash integer not null
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
  return db;
}
