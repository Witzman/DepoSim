import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { JOB_NAMES } from "../src/config.js";
import type { MarketData } from "../src/data/marketdata.js";
import { D0, DAY, H, SAP, bar, makeSource } from "./fakes.js";

const open: FastifyInstance[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const SPIKE_T = D0 + 7 * H + 20 * 60;

/** SAP has a tick at 1/100 of the price at minute 20 (rises 100..110 around it, so the price there is 120). */
function make(now = D0 + 5 * DAY, jobs?: string[]) {
  const { source, all } = makeSource();
  all[SAP.symbol][20] = { ...bar(SPIKE_T, 1.2), o: 100, h: 100.5 };
  const app = buildApp({
    dbPath: ":memory:", marketData: source as MarketData, instruments: [SAP], now: () => now, minGapMs: 0,
    jobSettings: jobs && { enabled: true, overrides: Object.fromEntries(JOB_NAMES.filter((n) => !jobs.includes(n)).map((n) => [n, "off" as const])) },
  });
  open.push(app);
  return app;
}

describe("flags in the API (#50)", () => {
  it("lists a marked bar with counts, and the bars of a simulation carry `flagged`", async () => {
    const app = make();
    const created = await app.inject({ method: "POST", url: "/api/simulations", payload: { name: "T", startAt: D0 + 7 * H + 30 * 60 } });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/api/simulations/${id}/start` });
    const flags = (await app.inject({ url: "/api/data/flags?symbol=SAP.DE" })).json();
    expect(flags.counts.spike).toBe(1);
    expect(flags.flags).toMatchObject([{ symbol: "SAP.DE", t: SPIKE_T, kind: "spike" }]);
    expect(flags.bySymbol[0]).toMatchObject({ symbol: "SAP.DE", spike: 1 });
    expect((await app.inject({ url: "/api/data/flags?from=-3" })).statusCode).toBe(400);
    const bars = (await app.inject({ url: `/api/simulations/${id}/bars?symbol=SAP.DE&limit=100` })).json().bars;
    expect(bars.filter((b: { flagged?: boolean }) => b.flagged).map((b: { t: number }) => b.t)).toEqual([SPIKE_T]);
    expect((await app.inject({ url: "/api/data/archive" })).json().flags.spike).toBe(1);
    const status = (await app.inject({ url: "/api/data/status" })).json();
    expect(status.reasons.some((r: { text: string }) => /Ausreißer/.test(r.text))).toBe(true);
  });

  it("the nightly check job runs over the stored days and writes its figures to the log", async () => {
    const now = { t: D0 + 5 * DAY };
    const app = make(now.t, ["pruefung"]);
    const id = (await app.inject({ method: "POST", url: "/api/simulations", payload: { name: "T", startAt: D0 + 7 * H + 30 * 60 } })).json().id;
    await app.inject({ method: "POST", url: `/api/simulations/${id}/start` });
    // the day is stored now; the spike flag from the load is replaced by the job's own finding
    await app.jobs.tick();
    const [run] = (await app.inject({ url: "/api/jobs" })).json().runs;
    expect(run).toMatchObject({ job: "pruefung", status: "ok" });
    expect(run.message).toMatch(/Ausreißer/);
    expect(run.counts).toMatchObject({ series: 2, spike: 1 }); // SAP.DE and the exchange rate
  });
});
