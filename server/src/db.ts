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
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
