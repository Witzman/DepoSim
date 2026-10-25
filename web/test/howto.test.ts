import { describe, expect, it } from "vitest";
import { DEFAULT_FEES, previewCost } from "../../server/src/domain/fees.js";
import { triggersLimit } from "../../server/src/domain/broker.js";
import { findGaps } from "../../server/src/domain/marketEvents.js";
import { PRESETS, applyRules, resolveRules } from "../../server/src/domain/rules.js";
import { entryOf } from "../src/glossary.js";
import { HOWTO, chapterOf, searchHowto } from "../src/howto.js";
import { COMMANDS } from "../src/palette.js";
import { PRESET_TEXT } from "../src/rules.js";

const eur = (cents: number) => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const examples = HOWTO.flatMap((c) => c.examples);
const bar = (low: number, high: number) => ({ t: 0, o: low, h: high, l: low, c: high, v: 1 });

describe("howto", () => {
  it("has unique chapter and example ids and text in every chapter", () => {
    const ids = HOWTO.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const ex = examples.map((e) => e.id);
    expect(new Set(ex).size).toBe(ex.length);
    for (const c of HOWTO) expect(c.body.length, c.id).toBeGreaterThan(0);
  });

  it("has the nine chapters the issue asks for", () => {
    expect(HOWTO).toHaveLength(9);
  });

  it("points only at glossary entries that exist", () => {
    for (const c of HOWTO) for (const id of c.see ?? []) expect(entryOf(id), `${c.id}: ${id}`).toBeDefined();
  });

  it("is reachable from the palette", () => {
    expect(COMMANDS.some((c) => c.id === "howto")).toBe(true);
  });

  it("has a worked example with figures in every chapter that does orders or events", () => {
    for (const id of ["setup", "orders", "events"]) expect(chapterOf(id)?.examples.length, id).toBeGreaterThan(0);
  });
});

describe("worked examples are what the engine computes", () => {
  for (const e of examples) {
    it(e.title, () => {
      const c = e.check;
      const text = e.text.replace(/ /g, " ");
      if (c.kind === "cost") {
        const fees = c.preset ? applyRules(DEFAULT_FEES, resolveRules(c.preset)) : DEFAULT_FEES;
        const ref = c.eurUsd !== undefined ? { price: c.price, currency: "USD" as const, eurUsd: c.eurUsd } : { price: c.price, currency: "EUR" as const };
        const r = previewCost(c.side, c.qty, ref, c.order, c.limit, fees);
        expect({ gross: r.gross, commission: r.commission, foreign: r.foreign, total: r.total }).toEqual(c.expect);
        for (const cents of [r.gross, r.commission, r.total, ...(r.foreign > 0 ? [r.foreign] : [])]) expect(text, `${eur(cents)} €`).toContain(`${eur(cents)} €`);
      } else if (c.kind === "limit") {
        const o = { id: 1, side: c.side, kind: "limit", limitPrice: c.limit, qty: 1, symbol: "X", status: "open" } as Parameters<typeof triggersLimit>[0];
        expect(triggersLimit(o, bar(c.low, c.high) as Parameters<typeof triggersLimit>[1])).toBe(c.fires);
      } else {
        const day = (d: number, o: number, close: number) => ({ t: Date.UTC(2026, 9, d, 8) / 1000, o, c: close });
        const [gap] = findGaps("ABC", [day(20, c.close, c.close), day(21, c.open, c.open)]);
        expect(gap?.text).toBe(c.text);
        expect(text).toContain("+4,0 %");
      }
    });
  }

  it("states the difference between market and limit buy and the hardcore surcharge correctly", () => {
    const ref = { price: 48.2, currency: "EUR" as const };
    const market = previewCost("buy", 100, ref, "market", undefined, DEFAULT_FEES).total;
    const limit = previewCost("buy", 100, ref, "limit", 48.2, DEFAULT_FEES).total;
    const hard = previewCost("buy", 100, ref, "market", undefined, applyRules(DEFAULT_FEES, resolveRules("hardcore"))).total;
    expect(eur(market - limit)).toBe("2,42");
    expect(eur(hard - market)).toBe("14,47");
    expect(chapterOf("orders")?.examples.find((e) => e.id === "limit-buy")?.text).toContain("2,42 €");
    expect(chapterOf("setup")?.examples[0].text).toContain("14,47 €");
  });

  it("does not trigger a buy limit when the low stays above it", () => {
    const o = { id: 1, side: "buy", kind: "limit", limitPrice: 48.2, qty: 1, symbol: "X", status: "open" } as Parameters<typeof triggersLimit>[0];
    expect(triggersLimit(o, bar(48.25, 48.6) as Parameters<typeof triggersLimit>[1])).toBe(false);
  });
});

describe("rules and fee model in the text", () => {
  const text = HOWTO.flatMap((c) => c.body).join(" ");

  it("states the fee model of the engine", () => {
    expect(DEFAULT_FEES.spreadPct).toBe(0.0005);
    expect(DEFAULT_FEES.commissionPct).toBe(0.0025);
    expect(DEFAULT_FEES.commissionMin).toBe(490);
    expect(DEFAULT_FEES.commissionMax).toBe(5990);
    expect(DEFAULT_FEES.foreignFlat).toBe(1490);
    expect(DEFAULT_FEES.fxMarkupPct).toBe(0.005);
    for (const s of ["0,05 %", "0,25 %", "4,90 €", "59,90 €", "14,90 €", "0,5 %"]) expect(text, s).toContain(s);
  });

  it("describes the difficulty levels as the presets are", () => {
    expect(PRESETS.relaxed).toMatchObject({ spreadFactor: 1, feeFactor: 1, pauseAllowed: true, tempoLocked: false });
    expect(PRESETS.realistic).toMatchObject({ spreadFactor: 1, feeFactor: 1, pauseAllowed: true, tempoLocked: false });
    expect(PRESETS.hardcore).toMatchObject({ spreadFactor: 2, feeFactor: 2, pauseAllowed: false, tempoLocked: true });
    expect(PRESET_TEXT.hardcore).toContain("Doppelter Spread");
    expect(text).toContain("Hardcore verdoppelt Spread und Gebühren, erlaubt keine Pause, hält das Tempo fest");
  });
});

describe("searchHowto", () => {
  it("finds the order chapter for Limit and puts title matches first", () => {
    expect(searchHowto("limit").map((c) => c.id)).toContain("orders");
    expect(searchHowto("Orders")[0].id).toBe("orders");
  });

  it("returns everything for an empty query and nothing for nonsense", () => {
    expect(searchHowto(" ")).toHaveLength(HOWTO.length);
    expect(searchHowto("qwertzuiop")).toEqual([]);
  });
});
