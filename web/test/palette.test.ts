import { describe, expect, it } from "vitest";
import { buildEntries } from "../src/palette.js";
import type { Instrument, SearchHit, Simulation } from "../src/types.js";

const inst = (symbol: string, name: string): Instrument => ({ symbol, name, currency: "EUR", venue: "XETRA" });
const SAP = inst("SAP.DE", "SAP");
const ISAP = inst("ISAP.DE", "Irgendwas");
const SIE = inst("SIE.DE", "Siemens");
const sim = (id: number, name: string): Simulation =>
  ({ id, name, startAt: 0, simulationTime: 0, tempo: 1, startCash: 1, createdAt: 0, endedAt: null, live: false, benchmark: null });
const hit = (symbol: string, name: string, known: boolean): SearchHit => ({ ...inst(symbol, name), known });

const kinds = (es: ReturnType<typeof buildEntries>) => es.map((e) => e.kind);

describe("buildEntries", () => {
  it("lists every instrument, then the simulations, then the theme command, for an empty query", () => {
    const es = buildEntries("  ", [SAP, SIE], [sim(1, "Alt"), sim(2, "Neu")], []);
    expect(kinds(es)).toEqual(["instrument", "instrument", "simulation", "simulation", "theme"]);
  });

  it("puts a symbol that starts with the query before one that only contains it", () => {
    const es = buildEntries("sap", [ISAP, SAP], [], []);
    expect(es.map((e) => (e.kind === "instrument" ? e.instrument.symbol : e.kind))).toEqual(["SAP.DE", "ISAP.DE"]);
  });

  it("finds an instrument by its name, ignoring case", () => {
    const es = buildEntries("SIEMENS", [SAP, SIE], [], []);
    expect(es).toEqual([{ kind: "instrument", instrument: SIE }]);
  });

  it("finds simulations by name", () => {
    const es = buildEntries("neu", [SAP], [sim(1, "Alt"), sim(2, "Neu")], []);
    expect(es).toEqual([{ kind: "simulation", simulation: sim(2, "Neu") }]);
  });

  it("offers the theme command for 'dunkel', 'hell', 'farbe' and 'theme', and not for other words", () => {
    for (const q of ["dunkel", "hell", "farbe", "theme"]) expect(kinds(buildEntries(q, [], [], [])), q).toEqual(["theme"]);
    expect(buildEntries("sap", [], [], [])).toEqual([]);
  });

  it("adds hits that are not in the list at the end, and never one that is", () => {
    const es = buildEntries("de", [SAP], [], [hit("SAP.DE", "SAP", true), hit("BMW.DE", "BMW", false)]);
    expect(kinds(es)).toEqual(["instrument", "hit"]);
    expect(es[1]).toMatchObject({ kind: "hit", hit: { symbol: "BMW.DE" } });
  });

  it("ignores a hit with known false when the symbol is in the list after all", () => {
    expect(kinds(buildEntries("sap", [SAP], [], [hit("SAP.DE", "SAP", false)]))).toEqual(["instrument"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(buildEntries("zzzz", [SAP], [sim(1, "Alt")], [])).toEqual([]);
  });
});
