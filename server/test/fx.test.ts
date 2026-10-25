import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type EcbSource, parseEcbCsv } from "../src/data/ecb.js";
import { MarketDataError } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";
import { createFx, lastPublication } from "../src/fx.js";
import { D0, DAY, FX, bar } from "./fakes.js";

const rows = parseEcbCsv(readFileSync(new URL("./fixtures/ecb-hist.csv", import.meta.url), "utf8"));
// 2026-10-24 12:00 UTC, a Saturday
const SAT = D0 + 2 * DAY + 12 * 3600;

function make(opts: { now?: number; fail?: MarketDataError; data?: typeof rows } = {}) {
  const db = openDb(":memory:");
  const calls: string[] = [];
  const clock = { now: opts.now ?? SAT };
  let fail = opts.fail;
  const source: EcbSource = {
    async fetch(range) {
      calls.push(range);
      if (fail) throw fail;
      return opts.data ?? rows;
    },
  };
  const fx = createFx({ db, source, now: () => clock.now });
  return { db, fx, calls, clock, setFail: (e?: MarketDataError) => (fail = e) };
}

describe("fx_daily", () => {
  it("is gapless from the first to the last day, filled days are marked", async () => {
    const { db, fx } = make();
    await fx.update();
    const usd = db.prepare("select day, rate, filled from fx_daily where ccy = 'USD' order by day").all() as { day: string; rate: number; filled: number }[];
    expect(usd.map((r) => r.day)).toEqual(["10-16", "10-17", "10-18", "10-19", "10-20", "10-21", "10-22", "10-23"].map((d) => `2026-${d}`));
    expect(usd.map((r) => r.filled)).toEqual([0, 1, 1, 0, 1, 1, 0, 0]);
    expect(usd.map((r) => r.rate)).toEqual([1.065, 1.065, 1.065, 1.07, 1.07, 1.07, 1.075, 1.08]);
  });

  it("fills a day the ECB left out for one currency with that currency's last rate, and stops at its last real day", async () => {
    const { db, fx } = make();
    await fx.update();
    const jpy = db.prepare("select day, rate, filled from fx_daily where ccy = 'JPY' and day between '2026-10-18' and '2026-10-20' order by day").all();
    expect(jpy).toEqual([
      { day: "2026-10-18", rate: 163, filled: 1 },
      { day: "2026-10-19", rate: 163, filled: 1 },
      { day: "2026-10-20", rate: 163, filled: 1 },
    ]);
    const czk = db.prepare("select max(day) as d from fx_daily where ccy = 'CZK'").get() as { d: string };
    expect(czk.d).toBe("2026-10-22");
  });

  it("asks for the whole file the first time and for the recent ones after that, and merges", async () => {
    const { db, fx, calls } = make();
    await fx.update();
    await fx.update();
    expect(calls).toEqual(["full", "recent"]);
    expect((db.prepare("select count(*) as n from fx_daily where ccy = 'USD'").get() as { n: number }).n).toBe(8);
  });

  it("fills the gap between what is stored and a newer answer", async () => {
    const { db, fx } = make({ data: rows.slice(0, 2) }); // 16th and 19th
    await fx.update();
    const later = parseEcbCsv("Date,USD,\n2026-10-23,1.08,\n");
    const db2 = db; // same db, a second service with a later answer
    const fx2 = createFx({ db: db2, source: { fetch: async () => later }, now: () => SAT });
    await fx2.update();
    const r = db.prepare("select filled, rate from fx_daily where ccy = 'USD' and day = '2026-10-21'").get();
    expect(r).toEqual({ filled: 1, rate: 1.07 });
  });
});

describe("rateOn", () => {
  it("answers with the rate of the day, its source and whether it was carried", async () => {
    const { fx } = make();
    await fx.update();
    expect(fx.rateOn("USD", "2026-10-22")).toMatchObject({ rate: 1.075, day: "2026-10-22", source: "ecb", filled: false, stale: false });
    const sat = fx.rateOn("USD", "2026-10-17")!;
    expect(sat).toMatchObject({ rate: 1.065, source: "ecb", filled: true, stale: false });
    expect(sat.label).toContain("aufgefüllt");
  });

  it("keeps the last known rate beyond the data and says so", async () => {
    const { fx } = make();
    await fx.update();
    const r = fx.rateOn("USD", "2026-11-05")!;
    expect(r).toMatchObject({ rate: 1.08, day: "2026-10-23", stale: true });
    expect(r.label).toBe("Kurs vom 23.10.2026");
  });

  it("has no rate before the first day, for an unknown currency, and EUR is 1", async () => {
    const { fx } = make();
    await fx.update();
    expect(fx.rateOn("USD", "2026-10-01")).toBeUndefined();
    expect(fx.rateOn("XXX", "2026-10-22")).toBeUndefined();
    expect(fx.rateOn("EUR", "2026-10-22")).toMatchObject({ rate: 1, stale: false });
  });

  it("prefers the minute series of EURUSD=X when asked and there is one for that day", async () => {
    const { db, fx } = make();
    await fx.update();
    const ins = db.prepare("insert into bars (symbol, t, o, h, l, c, v) values (?, ?, 1, 1, 1, ?, 0)");
    const b = bar(D0 + 13 * 3600, 1.1);
    ins.run(FX, b.t, b.c);
    ins.run(FX, b.t + 60, 1.2);
    expect(fx.rateOn("USD", "2026-10-22")).toMatchObject({ rate: 1.2, source: "yahoo-minute", label: "Yahoo, Minute" });
    expect(fx.rateOn("USD", "2026-10-22", { minute: false })).toMatchObject({ rate: 1.075, source: "ecb" });
    expect(fx.rateOn("USD", "2026-10-21")).toMatchObject({ source: "ecb" }); // no minutes that day
  });
});

describe("failure", () => {
  it("keeps what is stored and reports the error", async () => {
    const { fx, setFail } = make();
    await fx.update();
    setFail(new MarketDataError("network", "down"));
    const res = await fx.update();
    expect(res.ok).toBe(false);
    expect(fx.rateOn("USD", "2026-10-23")).toMatchObject({ rate: 1.08 });
    expect(fx.status()).toMatchObject({ latestDay: "2026-10-23" });
    expect(fx.status().error).toMatch(/nicht erreichbar/);
  });

  it("does not store anything from an answer that is not the file", async () => {
    const { db, fx, setFail } = make();
    setFail(new MarketDataError("bad_shape", "no"));
    expect((await fx.update()).ok).toBe(false);
    expect((db.prepare("select count(*) as n from fx_daily").get() as { n: number }).n).toBe(0);
  });
});

describe("when to fetch", () => {
  it("lastPublication is 16:30 Berlin of the latest day that has passed", () => {
    // 2026-10-24 12:00 UTC = 14:00 CEST: still the 23rd 16:30 CEST = 14:30 UTC
    expect(new Date(lastPublication(SAT) * 1000).toISOString()).toBe("2026-10-23T14:30:00.000Z");
    // 15:00 UTC = 17:00 CEST: the 24th 16:30 CEST
    expect(new Date(lastPublication(D0 + 2 * DAY + 15 * 3600) * 1000).toISOString()).toBe("2026-10-24T14:30:00.000Z");
    // winter time (2026-11-10): 16:30 CET = 15:30 UTC
    const nov = Date.parse("2026-11-10T20:00:00Z") / 1000;
    expect(new Date(lastPublication(nov) * 1000).toISOString()).toBe("2026-11-10T15:30:00.000Z");
  });

  it("runDaily fetches when never fetched, then once per publication", async () => {
    const { fx, calls, clock } = make();
    await fx.runDaily();
    await fx.runDaily();
    expect(calls).toEqual(["full"]);
    clock.now += 3 * 3600; // 17:00 CEST, after the 16:30 of the 24th
    await fx.runDaily();
    await fx.runDaily();
    expect(calls).toEqual(["full", "recent"]);
  });

  it("a failed fetch is tried again at the next look", async () => {
    const { fx, calls, setFail } = make();
    setFail(new MarketDataError("network", "down"));
    await fx.runDaily();
    setFail(undefined);
    await fx.runDaily();
    expect(calls).toEqual(["full", "full"]);
  });

  it("runStartup fetches only when nothing is stored or the newest day is older than two days", async () => {
    const { fx, calls, clock } = make({ now: Date.parse("2026-10-24T12:00:00Z") / 1000 });
    await fx.runStartup();
    expect(calls).toEqual(["full"]); // empty
    await fx.runStartup();
    expect(calls).toEqual(["full"]); // 23rd is one day old
    clock.now = Date.parse("2026-10-26T12:00:00Z") / 1000; // 23rd is three days old
    await fx.runStartup();
    expect(calls).toEqual(["full", "recent"]);
  });
});
