import { describe, expect, it } from "vitest";
import type { EcbRow } from "../src/data/ecb.js";
import type { DailySeries } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";
import { createFx } from "../src/fx.js";
import { createLongterm } from "../src/longterm.js";
import { D0, DAY } from "./fakes.js";

const NOW = D0 + 2 * DAY + 12 * 3600; // Sat 2026-10-24

const NO_FEES = { commissionPct: 0, commissionMin: 0, commissionMax: 0, foreignFlat: 0, fxMarkupPct: 0, spreadPct: 0 };
const SPY = { key: "spy", index: "S&P 500", symbol: "SPY", etf: "SPDR S&P 500 ETF", currency: "USD" };

/** SPY in USD, five days from Mon 2026-10-19, a dividend of 1.00 USD with ex-day Wed the 21st. */
const spy: DailySeries = {
  bars: [
    { day: "2026-10-19", o: 22, h: 22, l: 22, c: 22, v: 1 },
    { day: "2026-10-20", o: 24, h: 25, l: 24, c: 25, v: 1 },
    { day: "2026-10-21", o: 25, h: 25, l: 25, c: 25, v: 1 },
    { day: "2026-10-22", o: 26, h: 26, l: 26, c: 26, v: 1 },
    { day: "2026-10-23", o: 27, h: 28, l: 27, c: 28, v: 1 },
  ],
  dividends: [{ exDay: "2026-10-21", amount: 1 }],
  splits: [],
};
/** USD per EUR, a different rate on the ex-day so a wrong day shows. */
const rates: Record<string, number> = { "2026-10-19": 2, "2026-10-20": 2, "2026-10-21": 2.5, "2026-10-22": 2, "2026-10-23": 2 };
const ecb = (days: string[]): EcbRow[] => days.map((day) => ({ day, rates: { USD: rates[day] } }));

async function run(days = Object.keys(rates)) {
  const db = openDb(":memory:");
  const fx = createFx({ db, source: { fetch: async () => ecb(days) }, now: () => NOW });
  const lt = createLongterm({ db, source: { daily: async () => spy }, now: () => NOW, minGapMs: 0, fees: NO_FEES, fx, depots: [SPY] });
  return { db, fx, lt };
}

describe("Langzeitvergleich with a USD value", () => {
  it("converts prices at the rate of the trading day and the dividend at the rate of the ex-day (hand-made table)", async () => {
    const { fx, lt } = await run();
    await fx.update();
    lt.start();
    await lt.settled();
    const r = lt.compute();
    expect(r.ready).toBe(true);
    if (!r.ready) return;
    const d = r.depots[0];
    // 19th: open 22 USD / 2.0 = 11.00 EUR, 40,000 EUR buy 3636 shares (39,996.00), 4.00 EUR left.
    // 21st: ex-day, 1.00 USD / 2.5 = 0.40 EUR x 3636 = 1,454.40 EUR credited.
    // 22nd: open 26 / 2.0 = 13.00 EUR buys 112 more (1,456.00 > 1,458.40 - ...: floor(1458.40 / 13) = 112), 2.40 EUR left.
    // 23rd: close 28 / 2.0 = 14.00 EUR x 3748 = 52,472.00 + 2.40.
    expect(d.curve).toEqual([
      ["2026-10-19", 4_000_000],
      ["2026-10-20", 4_545_400],
      ["2026-10-21", 3_781_840],
      ["2026-10-22", 4_872_640],
      ["2026-10-23", 5_247_440],
    ]);
    expect(d.totals.dividendsReceived).toBe(145_440);
    expect(d.totals.shares).toBe(3748);
    expect(d.totals.finalValue).toBe(5_247_440);
    expect(d.currency).toBe("USD");
    expect(d.fx).toMatchObject({ currency: "USD", source: "ecb", lastRateDay: "2026-10-23", stale: false });
  });

  it("keeps the last known rate when the data stops early and says 'Kurs vom'", async () => {
    const { fx, lt } = await run(["2026-10-19", "2026-10-20", "2026-10-21"]);
    await fx.update();
    lt.start();
    await lt.settled();
    const r = lt.compute();
    if (!r.ready) throw new Error("not ready");
    const d = r.depots[0];
    // the 22nd and 23rd use 2.5: 28 / 2.5 = 11.20 EUR
    expect(d.curve[4][0]).toBe("2026-10-23");
    expect(d.fx).toMatchObject({ lastRateDay: "2026-10-21", stale: true });
    expect(d.fx!.label).toContain("Kurs vom 21.10.2026");
  });

  it("is not ready without rates", async () => {
    const { lt } = await run();
    lt.start();
    await lt.settled();
    const r = lt.compute();
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.missing[0]).toMatchObject({ symbol: "SPY", reason: expect.stringContaining("Wechselkurse") });
  });
});
