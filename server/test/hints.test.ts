import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { HINT_RULES, type HintInput, currentLosingStreak, defaultConfig, evaluateHints, orderNotes } from "../src/domain/hints.js";
import { AAPL, D0, H, SAP, makeSource } from "./fakes.js";

const DAY = 86400;
const base = (over: Partial<HintInput> = {}): HintInput => ({
  depotValue: 1_000_000, cash: 500_000, startCash: 1_000_000, positions: [], curve: [], now: 100 * DAY, feeShareOfStart: 0, trades: [], metricsBasis: "day", ...over,
});
const pos = (symbol: string, value: number, sector = "Technology", currency: "EUR" | "USD" = "EUR") => ({ symbol, value, sector, currency });
const rules = (hints: ReturnType<typeof evaluateHints>) => hints.map((h) => h.rule);

describe("evaluateHints", () => {
  it("says nothing about an empty depot or one with only cash", () => {
    expect(evaluateHints(base({ cash: 1_000_000 }))).toEqual([]);
    expect(evaluateHints(base({ depotValue: 0, cash: 0 }))).toEqual([]);
  });

  it("reports the largest position at 25 % as info and at 40 % as warning, and nothing below", () => {
    const four = evaluateHints(base({ cash: 0, positions: Array.from({ length: 4 }, (_, i) => pos(`S${i}`, 250_000, `X${i}`)) }));
    expect(four.find((h) => h.rule === "largest")).toBeUndefined(); // exactly 25 % is not above the threshold
    const eight = evaluateHints(base({ cash: 0, positions: [pos("A", 300_000), ...Array.from({ length: 7 }, (_, i) => pos(`S${i}`, 100_000, `X${i}`))] }));
    expect(eight.find((h) => h.rule === "largest")).toMatchObject({ severity: "info", measure: 0.3, threshold: 0.25 });
    const heavy = evaluateHints(base({ cash: 0, positions: [pos("A", 450_000), pos("B", 550_000, "Energy")] }));
    expect(heavy.find((h) => h.rule === "largest")).toMatchObject({ severity: "warn", threshold: 0.4 });
    expect(heavy.find((h) => h.rule === "largest")!.text).toContain("B ist 55 %");
  });

  it("names measure and threshold in every hint", () => {
    const hints = evaluateHints(base({ cash: 0, positions: [pos("A", 500_000), pos("B", 300_000), pos("C", 200_000, "Energy")] }));
    for (const h of hints) {
      expect(h.text.length).toBeGreaterThan(10);
      expect(typeof h.measure).toBe("number");
      expect(typeof h.threshold).toBe("number");
    }
    expect(rules(hints)).toEqual(expect.arrayContaining(["largest", "top3", "sector"]));
  });

  it("ignores ETFs and unknown titles for the sector rule", () => {
    const hints = evaluateHints(base({ cash: 0, positions: [pos("E1", 600_000, "ETF/Fonds"), pos("E2", 400_000, "ETF/Fonds")] }));
    expect(rules(hints)).not.toContain("sector");
  });

  it("flags more than half in dollars", () => {
    const hints = evaluateHints(base({ cash: 400_000, positions: [pos("US", 600_000, "Technology", "USD")] }));
    expect(rules(hints)).toContain("usd");
  });

  it("checks the cash quota only once something is held", () => {
    expect(rules(evaluateHints(base({ cash: 1_000_000 })))).toEqual([]);
    expect(rules(evaluateHints(base({ cash: 10_000, positions: [pos("A", 990_000)] })))).toContain("cashLow");
    expect(rules(evaluateHints(base({ cash: 700_000, positions: [pos("A", 300_000)] })))).toContain("cashHigh");
  });

  it("flags fees above 1 % of the start cash", () => {
    expect(rules(evaluateHints(base({ feeShareOfStart: 0.0101 })))).toContain("fees");
    expect(rules(evaluateHints(base({ feeShareOfStart: 0.01 })))).not.toContain("fees");
  });

  it("measures the drawdown from the peak and says since when", () => {
    const curve = [{ t: 0, value: 1000 }, { t: 10 * DAY, value: 1200 }, { t: 20 * DAY, value: 1000 }];
    const h = evaluateHints(base({ curve, now: 20 * DAY })).find((x) => x.rule === "drawdown")!;
    expect(h).toMatchObject({ severity: "info" });
    expect(h.measure).toBeCloseTo(1 - 1000 / 1200, 9);
    expect(h.text).toContain("seit 10 Tagen");
    const deep = evaluateHints(base({ curve: [{ t: 0, value: 1000 }, { t: DAY, value: 700 }], now: DAY })).find((x) => x.rule === "drawdown")!;
    expect(deep.severity).toBe("warn");
  });

  it("counts the losing streak at the end, not the longest one", () => {
    const t = (netPnl: number, i: number) => ({ netPnl, closedSim: i, sellOrderId: i });
    expect(currentLosingStreak([t(-1, 1), t(-1, 2), t(-1, 3), t(-1, 4), t(5, 5), t(-1, 6)])).toBe(1);
    const hints = evaluateHints(base({ trades: [t(5, 1), t(-1, 2), t(-1, 3), t(-1, 4), t(-1, 5)] }));
    expect(hints.find((h) => h.rule === "losingStreak")).toMatchObject({ severity: "warn", measure: 4 });
  });

  it("flags a high turnover and a disposition ratio over the thresholds, and nothing while the sample is too small", () => {
    expect(rules(evaluateHints(base({ behavior: { yearlyTurnover: 3.5, dispositionRatio: 2 } })))).toEqual(expect.arrayContaining(["turnover", "disposition"]));
    expect(rules(evaluateHints(base({ behavior: { yearlyTurnover: 3, dispositionRatio: 1.5 } })))).not.toContain("turnover");
    expect(rules(evaluateHints(base({ behavior: { yearlyTurnover: 3, dispositionRatio: 1.5 } })))).not.toContain("disposition");
    expect(rules(evaluateHints(base({ behavior: { yearlyTurnover: null, dispositionRatio: null } })))).not.toContain("turnover");
    expect(rules(evaluateHints(base({})))).not.toContain("disposition");
  });

  it("notes thin data once there is a curve but no basis", () => {
    const curve = [{ t: 0, value: 1 }, { t: 1, value: 1 }];
    expect(rules(evaluateHints(base({ curve, metricsBasis: null })))).toContain("data");
    expect(rules(evaluateHints(base({ curve: [], metricsBasis: null })))).not.toContain("data");
  });

  it("switches a rule off and uses another threshold", () => {
    const cfg = defaultConfig();
    cfg.fees = { enabled: false, levels: [0.01] };
    expect(rules(evaluateHints(base({ feeShareOfStart: 0.5 }), cfg))).toEqual([]);
    cfg.fees = { enabled: true, levels: [0.6] };
    expect(rules(evaluateHints(base({ feeShareOfStart: 0.5 }), cfg))).toEqual([]);
    cfg.fees = { enabled: true, levels: [0.4] };
    expect(rules(evaluateHints(base({ feeShareOfStart: 0.5 }), cfg))).toEqual(["fees"]);
  });

  it("lists warnings before info", () => {
    const hints = evaluateHints(base({ cash: 0, positions: [pos("A", 450_000), pos("B", 550_000, "Energy")], feeShareOfStart: 0.05 }));
    const sev = hints.map((h) => h.severity);
    expect(sev).toEqual([...sev].sort((a, b) => (a === b ? 0 : a === "warn" ? -1 : 1)));
  });
});

describe("orderNotes", () => {
  const o = { side: "buy" as const, symbol: "A", depotValue: 1_000_000, afterValue: 300_000, foreignFee: 0, orderTotal: 300_000 };
  it("warns when a buy would push the position over the threshold", () => {
    expect(orderNotes(o)).toEqual([expect.stringContaining("wäre A 30 %")]);
    expect(orderNotes({ ...o, afterValue: 200_000 })).toEqual([]);
    expect(orderNotes({ ...o, side: "sell" })).toEqual([]);
  });

  it("says when the foreign flat fee is more than 1 % of the order", () => {
    expect(orderNotes({ ...o, afterValue: 100_000, foreignFee: 1490, orderTotal: 100_000 })[0]).toMatch(/Auslandspauschale.*zu klein/);
    expect(orderNotes({ ...o, afterValue: 100_000, foreignFee: 1490, orderTotal: 1_000_000 })).toEqual([]);
  });
});

describe("rule table", () => {
  it("has a glossary id for every rule", () => {
    for (const info of Object.values(HINT_RULES)) expect(info.why).not.toBe("");
  });
});

const open: FastifyInstance[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });
async function make() {
  const { source } = makeSource();
  const app = buildApp({ dbPath: ":memory:", marketData: source, instruments: [SAP, AAPL], now: () => D0 + 5 * DAY, minGapMs: 0, tickMs: 20 });
  open.push(app);
  const sim = (await app.inject({ method: "POST", url: "/api/simulations", payload: { name: "H", startAt: D0 + 7 * H + 600 } })).json();
  return { app, id: sim.id as number };
}

describe("hints API", () => {
  it("gives a depot with one big buy a clump hint and lets it be hidden, per simulation and rule", async () => {
    const { app, id } = await make();
    const buy = await app.inject({ method: "POST", url: `/api/simulations/${id}/orders`, payload: { symbol: "SAP.DE", side: "buy", kind: "market", qty: 50 } });
    expect(buy.statusCode).toBe(201);
    const first = (await app.inject({ url: `/api/simulations/${id}/hints` })).json();
    expect(first.hints.map((h: any) => h.rule)).toContain("largest");
    expect(first.rules.map((r: any) => r.rule)).toContain("losingStreak");

    expect((await app.inject({ method: "PUT", url: `/api/simulations/${id}/hints/largest`, payload: { hidden: true } })).statusCode).toBe(204);
    const hidden = (await app.inject({ url: `/api/simulations/${id}/hints` })).json();
    expect(hidden.hints.map((h: any) => h.rule)).not.toContain("largest");
    expect(hidden.hiddenCount).toBeGreaterThan(0);
    expect(hidden.rules.find((r: any) => r.rule === "largest").hidden).toBe(true);
    // still hidden after the service is asked again; another simulation is not touched
    const { id: other } = await (async () => ({ id: (await app.inject({ method: "POST", url: "/api/simulations", payload: { name: "2", startAt: D0 + 7 * H + 600 } })).json().id as number }))();
    expect((await app.inject({ url: `/api/simulations/${other}/hints` })).json().rules.find((r: any) => r.rule === "largest").hidden).toBe(false);
  });

  it("stores a threshold and a switch, and refuses nonsense", async () => {
    const { app, id } = await make();
    const put = (rule: string, payload: unknown) => app.inject({ method: "PUT", url: `/api/simulations/${id}/hints/${rule}`, payload: payload as object });
    expect((await put("largest", { levels: [0.5, 0.7] })).statusCode).toBe(204);
    expect((await put("fees", { enabled: false })).statusCode).toBe(204);
    const r = (await app.inject({ url: `/api/simulations/${id}/hints` })).json().rules;
    expect(r.find((x: any) => x.rule === "largest").levels).toEqual([0.5, 0.7]);
    expect(r.find((x: any) => x.rule === "fees").enabled).toBe(false);
    expect((await put("largest", { levels: [0.7, 0.5] })).statusCode).toBe(400);
    expect((await put("largest", { levels: [0.5] })).statusCode).toBe(400);
    expect((await put("nope", { enabled: false })).statusCode).toBe(400);
    expect((await put("data", { levels: [1] })).statusCode).toBe(400);
  });

  it("adds a note to the order preview when a buy would make the position large", async () => {
    const { app, id } = await make();
    const res = await app.inject({ method: "POST", url: `/api/simulations/${id}/orders/preview`, payload: { symbol: "SAP.DE", side: "buy", kind: "market", qty: 60 } });
    expect(res.json().notes).toEqual([expect.stringContaining("wäre SAP.DE")]);
    const small = await app.inject({ method: "POST", url: `/api/simulations/${id}/orders/preview`, payload: { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 } });
    expect(small.json().notes).toBeUndefined();
  });
});
