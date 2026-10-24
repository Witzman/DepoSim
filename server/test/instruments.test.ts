import { describe, expect, it } from "vitest";
import { FX_SYMBOL, type Instrument, MAX_ADDED } from "../src/config.js";
import { openDb } from "../src/db.js";
import { InstrumentRegistry, RegistryError } from "../src/instruments.js";
import { AAPL, SAP } from "./fakes.js";

const extra = (n: number): Instrument => ({ symbol: `X${n}.DE`, name: `Extra ${n}`, currency: "EUR", venue: "XETRA" });
const kindOf = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    return err instanceof RegistryError ? err.kind : "other";
  }
  return "none";
};

describe("InstrumentRegistry", () => {
  it("lists the seed in its order when nothing was added", () => {
    const reg = new InstrumentRegistry(openDb(":memory:"), [SAP, AAPL]);
    expect(reg.list()).toEqual([SAP, AAPL]);
    expect(reg.get("AAPL")).toEqual(AAPL);
    expect(reg.get("NOPE")).toBeUndefined();
    expect(reg.isAdded("AAPL")).toBe(false);
  });

  it("puts an added instrument after the seed and keeps it across a new registry on the same database", () => {
    const db = openDb(":memory:");
    new InstrumentRegistry(db, [SAP, AAPL]).add(extra(1));
    const again = new InstrumentRegistry(db, [SAP, AAPL]);
    expect(again.list()).toEqual([SAP, AAPL, extra(1)]);
    expect(again.isAdded("X1.DE")).toBe(true);
  });

  it("adds the same symbol twice without a second entry and without an error", () => {
    const reg = new InstrumentRegistry(openDb(":memory:"), [SAP]);
    reg.add(extra(1));
    reg.add(extra(1));
    expect(reg.list()).toEqual([SAP, extra(1)]);
  });

  it("keeps added instruments in the order they were added", () => {
    const reg = new InstrumentRegistry(openDb(":memory:"), [SAP]);
    reg.add(extra(2));
    reg.add(extra(1));
    expect(reg.list().map((i) => i.symbol)).toEqual(["SAP.DE", "X2.DE", "X1.DE"]);
  });

  it("refuses the 13th new instrument as full", () => {
    const reg = new InstrumentRegistry(openDb(":memory:"), [SAP]);
    for (let n = 1; n <= MAX_ADDED; n++) reg.add(extra(n));
    expect(kindOf(() => reg.add(extra(MAX_ADDED + 1)))).toBe("full");
    expect(reg.list()).toHaveLength(1 + MAX_ADDED);
    reg.add(extra(1)); // one that is already there is still not an error
  });

  it("refuses the exchange rate as an instrument", () => {
    const reg = new InstrumentRegistry(openDb(":memory:"), [SAP]);
    expect(kindOf(() => reg.add({ ...AAPL, symbol: FX_SYMBOL }))).toBe("fx");
  });

  it("refuses to remove the seed, and an unknown symbol, and removes an added one", () => {
    const reg = new InstrumentRegistry(openDb(":memory:"), [SAP]);
    reg.add(extra(1));
    expect(kindOf(() => reg.remove("SAP.DE"))).toBe("seed");
    expect(kindOf(() => reg.remove("NOPE"))).toBe("unknown");
    reg.remove("X1.DE");
    expect(reg.list()).toEqual([SAP]);
  });
});
