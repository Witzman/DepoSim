import { FX_SYMBOL, type Instrument, MAX_ADDED } from "./config.js";
import type { Db } from "./db.js";

export type RegistryErrorKind = "full" | "fx" | "seed" | "unknown";

export class RegistryError extends Error {
  readonly kind: RegistryErrorKind;

  constructor(kind: RegistryErrorKind, message: string) {
    super(message);
    this.name = "RegistryError";
    this.kind = kind;
  }
}

interface Row {
  symbol: string;
  name: string;
  currency: Instrument["currency"];
  venue: Instrument["venue"];
  sector: string | null;
  kind: Instrument["kind"] | null;
}

/**
 * The instruments that can be traded: the starting list in the code, then the ones the person
 * added, kept in the database. One list for every simulation. Read it on every use, never copy it.
 */
export class InstrumentRegistry {
  constructor(
    private readonly db: Db,
    private readonly seed: Instrument[],
  ) {}

  list(): Instrument[] {
    const added = this.db
      .prepare("select symbol, name, currency, venue, sector, kind from instruments order by position")
      .all() as Row[];
    return [
      ...this.seed,
      ...added.map(({ sector, kind, ...rest }): Instrument => ({
        ...rest, ...(kind ? { kind } : {}), ...(sector ? { sector } : {}),
      })),
    ];
  }

  get(symbol: string): Instrument | undefined {
    return this.list().find((i) => i.symbol === symbol);
  }

  isAdded(symbol: string): boolean {
    return this.db.prepare("select 1 from instruments where symbol = ?").get(symbol) !== undefined;
  }

  /** Adding what is already there changes nothing. */
  add(inst: Instrument): void {
    if (inst.symbol === FX_SYMBOL) throw new RegistryError("fx", "Der Wechselkurs ist kein Wertpapier.");
    if (this.get(inst.symbol)) return;
    const count = (this.db.prepare("select count(*) as n from instruments").get() as { n: number }).n;
    if (count >= MAX_ADDED) {
      throw new RegistryError("full", `Es sind höchstens ${MAX_ADDED} eigene Wertpapiere möglich.`);
    }
    const next = (this.db.prepare("select coalesce(max(position), 0) + 1 as p from instruments").get() as { p: number }).p;
    this.db
      .prepare("insert into instruments (symbol, name, currency, venue, position, sector, kind) values (?, ?, ?, ?, ?, ?, ?)")
      .run(inst.symbol, inst.name, inst.currency, inst.venue, next, inst.sector ?? null, inst.kind ?? null);
  }

  remove(symbol: string): void {
    if (this.seed.some((i) => i.symbol === symbol)) {
      throw new RegistryError("seed", "Dieses Wertpapier gehört zum Startbestand.");
    }
    if (this.db.prepare("delete from instruments where symbol = ?").run(symbol).changes === 0) {
      throw new RegistryError("unknown", `Unbekanntes Wertpapier ${symbol}.`);
    }
  }
}
