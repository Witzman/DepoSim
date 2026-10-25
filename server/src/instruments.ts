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

  private cache: { list: Instrument[]; bySymbol: Map<string, Instrument>; added: Set<string> } | null = null;

  /** Forget what was read: the table was changed from outside (a restore). `add` and `remove` do it themselves. */
  invalidate(): void {
    this.cache = null;
  }

  private read() {
    if (this.cache) return this.cache;
    const added = this.db
      .prepare("select symbol, name, currency, venue, sector, kind from instruments order by position")
      .all() as Row[];
    const list = [
      ...this.seed,
      ...added.map(({ sector, kind, ...rest }): Instrument => ({
        ...rest, ...(kind ? { kind } : {}), ...(sector ? { sector } : {}),
      })),
    ];
    const bySymbol = new Map<string, Instrument>();
    for (const i of list) if (!bySymbol.has(i.symbol)) bySymbol.set(i.symbol, i);
    return (this.cache = { list, bySymbol, added: new Set(added.map((r) => r.symbol)) });
  }

  list(): Instrument[] {
    return this.read().list;
  }

  get(symbol: string): Instrument | undefined {
    return this.read().bySymbol.get(symbol);
  }

  isAdded(symbol: string): boolean {
    return this.read().added.has(symbol);
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
    this.invalidate();
  }

  remove(symbol: string): void {
    if (this.seed.some((i) => i.symbol === symbol)) {
      throw new RegistryError("seed", "Dieses Wertpapier gehört zum Startbestand.");
    }
    if (this.db.prepare("delete from instruments where symbol = ?").run(symbol).changes === 0) {
      throw new RegistryError("unknown", `Unbekanntes Wertpapier ${symbol}.`);
    }
    this.invalidate();
  }
}
