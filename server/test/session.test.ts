import { describe, expect, it, vi } from "vitest";
import { createArchive } from "../src/data/archive.js";
import type { MarketDataErrorKind } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";
import { DEFAULT_FEES } from "../src/domain/fees.js";
import { parseAutoPause } from "../src/domain/autopause.js";
import { InstrumentRegistry } from "../src/instruments.js";
import { SessionService } from "../src/session.js";
import { createStore } from "../src/store.js";
import type { Instrument } from "../src/config.js";
import { AAPL, D0, D1, FX, H, SAP, makeSource } from "./fakes.js";

interface SetupOpts {
  startAt?: number;
  startCash?: number;
  fees?: typeof DEFAULT_FEES;
  fail?: MarketDataErrorKind;
  noDataFor?: string[];
  now?: number;
  live?: boolean;
  instruments?: Instrument[];
  delayS?: number;
  catchUpTempo?: number;
}

function setup(opts: SetupOpts = {}) {
  const { source, calls, all } = makeSource(opts);
  const clock = { now: opts.now ?? D0 + 5 * 86400 }; // a test can move it
  const db = openDb(":memory:");
  const store = createStore(db);
  const archive = createArchive(db, source, { now: () => clock.now, minGapMs: 0 });
  const registry = new InstrumentRegistry(db, opts.instruments ?? [SAP, AAPL]);
  const make = () =>
    new SessionService({
      store, archive, instruments: registry, fxSymbol: FX, now: () => clock.now,
      delayS: opts.delayS, catchUpTempo: opts.catchUpTempo,
    });
  const svc = make();
  const sim = store.createSimulation({
    name: "T", startAt: opts.startAt ?? D0 + 7 * H + 600, startCash: opts.startCash ?? 1_000_000,
    fees: opts.fees ?? DEFAULT_FEES, live: opts.live,
  });
  const depotId = store.listDepots(sim.id)[0].id;
  return { db, store, archive, registry, svc, make, sim, id: sim.id, depotId, calls, all, clock };
}

const orderOf = (t: ReturnType<typeof setup>, orderId: number) =>
  t.svc.snapshot(t.id).depots[0].orders.find((o) => o.id === orderId)!;

describe("start", () => {
  it("loads the start day of every instrument and of the exchange rate", async () => {
    const t = setup();
    await t.svc.start(t.id);
    expect([...new Set(t.calls)].sort()).toEqual(["AAPL", FX, "SAP.DE"].sort());
    expect(t.archive.barsBetween("SAP.DE", D0, D1)).toHaveLength(60);
  });

  it("refuses to start when the source is rate limited, and the simulation stays as it was", async () => {
    const t = setup({ fail: "rate_limited" });
    await expect(t.svc.start(t.id)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(t.store.getSimulation(t.id)?.simulationTime).toBe(t.sim.startAt);
  });

  it("says no_data when no instrument traded on that day", async () => {
    const t = setup({ noDataFor: ["SAP.DE", "AAPL"] });
    await expect(t.svc.start(t.id)).rejects.toMatchObject({ kind: "no_data", message: expect.stringMatching(/keine Kurse/) });
  });

  it("still starts when only one market has no data that day, like a holiday", async () => {
    const t = setup({ noDataFor: ["AAPL"] });
    await expect(t.svc.start(t.id)).resolves.toBeUndefined();
  });
});

describe("instruments added while the service runs", () => {
  const NOBAR = { symbol: "NOBAR.DE", name: "Ohne Kerzen", currency: "EUR", venue: "XETRA" } as const;

  it("shows an added instrument in the snapshot once the archive has bars for it, and not before", async () => {
    const t = setup({ instruments: [SAP], startAt: D0 + 13 * H + 1800 + 600 });
    await t.svc.start(t.id);
    expect(Object.keys(t.svc.snapshot(t.id).prices)).toEqual(["SAP.DE"]);
    t.registry.add(AAPL);
    expect(Object.keys(t.svc.snapshot(t.id).prices)).toEqual(["SAP.DE"]); // no bars for AAPL in the archive yet
    await t.archive.ensureDay("AAPL", D0);
    expect(t.svc.snapshot(t.id).prices.AAPL).toMatchObject({ price: 309 });
  });

  it("leaves an added instrument without bars out of the prices and does not disturb the tick", async () => {
    const t = setup({ instruments: [SAP], startAt: D0 + 7 * H + 600 });
    await t.svc.start(t.id);
    t.registry.add(NOBAR);
    const before = t.svc.snapshot(t.id);
    expect(before.prices["NOBAR.DE"]).toBeUndefined();
    const r = t.svc.tick(t.id, 1000);
    expect(r.simulationTime).toBeGreaterThan(t.sim.startAt);
    expect(r.newBars["NOBAR.DE"]).toBeUndefined();
  });

  it("refuses to place an order for an added instrument that has no price, so none stays open for good", async () => {
    const t = setup({ instruments: [SAP], startAt: D0 + 7 * H + 600 });
    await t.svc.start(t.id);
    t.registry.add(NOBAR);
    const res = t.svc.placeOrder(t.id, t.depotId, { symbol: "NOBAR.DE", side: "buy", kind: "market", qty: 1 });
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/keinen Kurs/) });
    expect(t.svc.snapshot(t.id).depots[0].orders).toEqual([]);
    expect(t.store.symbolInUse("NOBAR.DE")).toBe(false);
  });

  it("rejects an order for an added instrument that has no price yet, with a reason", async () => {
    const t = setup({ instruments: [SAP], startAt: D0 + 7 * H + 600 });
    await t.svc.start(t.id);
    t.registry.add(NOBAR);
    const res = t.svc.previewOrder(t.id, { symbol: "NOBAR.DE", side: "buy", kind: "market", qty: 1 });
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/keinen Kurs/) });
  });
});

describe("prepareInstrument", () => {
  const NOBAR = { symbol: "NOBAR.DE", name: "Ohne Kerzen", currency: "EUR", venue: "XETRA" } as const;

  it("loads the day of every open simulation and the days before for the new instrument", async () => {
    const t = setup({ instruments: [SAP], startAt: D1 + 7 * H + 600 });
    await t.svc.start(t.id);
    await t.svc.prepareInstrument(AAPL);
    expect(t.archive.barsBetween("AAPL", D0, D1)).toHaveLength(60); // D1 itself has none, D0 is one day before
  });

  it("does not throw for an instrument that has no bars at all", async () => {
    const t = setup({ instruments: [SAP] });
    await t.svc.start(t.id);
    await expect(t.svc.prepareInstrument(NOBAR)).resolves.toBeUndefined();
  });

  it("passes on a rate limit of the source", async () => {
    const t = setup({ instruments: [SAP] });
    await t.svc.start(t.id);
    const limited = setup({ instruments: [SAP], fail: "rate_limited" });
    await expect(limited.svc.prepareInstrument(AAPL)).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("skips ended simulations", async () => {
    const t = setup({ instruments: [SAP], startAt: D0 + 13 * H + 1800 + 600 });
    t.store.endSimulation(t.id);
    await t.svc.prepareInstrument(AAPL);
    expect(t.calls.filter((c) => c === "AAPL")).toHaveLength(0);
  });
});

describe("placeOrder", () => {
  it("fills a market buy at once at the last close plus spread while the market is open", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    expect(r.ok).toBe(true);
    const o = orderOf(t, (r as { orderId: number }).orderId);
    expect(o).toMatchObject({ status: "filled", gross: 10905, commission: 490, foreignFee: 0, filledSim: t.sim.startAt });
    expect(o.fillPrice).toBeCloseTo(109.0545, 6);
    const snap = t.svc.snapshot(t.id);
    expect(snap.depots[0].cash).toBe(1_000_000 - 11395);
    expect(snap.depots[0].positions).toEqual([{ symbol: "SAP.DE", qty: 1, cost: 11395, value: 10900 }]);
  });

  it("rejects what validateOrder rejects, says why, and stores no order", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 0 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Menge/) });
    expect(t.svc.snapshot(t.id).depots[0].orders).toEqual([]);
  });

  it("rejects an unknown symbol and an ended simulation", async () => {
    const t = setup();
    await t.svc.start(t.id);
    expect(t.svc.placeOrder(t.id, t.depotId, { symbol: "NOPE", side: "buy", kind: "market", qty: 1 }).ok).toBe(false);
    t.store.endSimulation(t.id);
    expect(t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 }).ok).toBe(false);
  });

  it("keeps a market buy open while the market is closed and fills it at the first bar's open", async () => {
    const t = setup({ startAt: D0 + 6 * H });
    await t.svc.start(t.id);
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    expect(r.ok).toBe(true);
    const id = (r as { orderId: number }).orderId;
    expect(orderOf(t, id).status).toBe("open");
    expect(t.svc.snapshot(t.id).depots[0].cash).toBe(1_000_000);

    t.svc.setTempo(t.id, 60);
    const res = t.svc.tick(t.id, 1000);
    expect(res.simulationTime).toBe(D0 + 7 * H + 60);
    expect(orderOf(t, id)).toMatchObject({ status: "filled", gross: 9980, commission: 490 });
    expect(t.svc.snapshot(t.id).depots[0].cash).toBe(1_000_000 - 10470);
  });

  it("buys a USD instrument at the exchange rate of that time and pays the foreign fee", async () => {
    const t = setup({ startAt: D0 + 13 * H + 1800 + 600 }); // 13:40, the last finished AAPL bar is no. 9, close 309
    await t.svc.start(t.id);
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "AAPL", side: "buy", kind: "market", qty: 1 });
    expect(r.ok).toBe(true);
    expect(orderOf(t, (r as { orderId: number }).orderId)).toMatchObject({
      status: "filled", gross: 28246, commission: 490, foreignFee: 1490,
    });
    expect(t.svc.snapshot(t.id).depots[0].cash).toBe(1_000_000 - 30226);
  });

  it("sells a held position and removes it", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "sell", kind: "market", qty: 1 });
    expect(r.ok).toBe(true);
    const snap = t.svc.snapshot(t.id);
    expect(snap.depots[0].positions).toEqual([]);
    expect(snap.depots[0].cash).toBe(1_000_000 - 11395 + 10405);
  });

  it("cancels an open order but not a filled one", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const open = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 50 });
    const filled = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    expect(t.svc.cancelOrder(t.id, (open as { orderId: number }).orderId)).toEqual({ ok: true });
    expect(orderOf(t, (open as { orderId: number }).orderId).status).toBe("cancelled");
    expect(t.svc.cancelOrder(t.id, (filled as { orderId: number }).orderId).ok).toBe(false);
    expect(t.svc.cancelOrder(t.id, 9999).ok).toBe(false);
  });
});

describe("tick", () => {
  it("returns the bars that finished inside the window, oldest first, per instrument", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 60);
    const r = t.svc.tick(t.id, 3000); // +180 s: bars 10, 11, 12 finish
    expect(r.simulationTime).toBe(D0 + 7 * H + 780);
    expect(r.newBars["SAP.DE"].map((b) => b.t)).toEqual([D0 + 7 * H + 600, D0 + 7 * H + 660, D0 + 7 * H + 720]);
    expect(r.newBars["AAPL"]).toBeUndefined();
    expect(r.newBars[FX]).toBeUndefined();
    expect(r.endOfData).toBe(false);
  });

  it("fills a limit buy at the limit price on the first bar that reaches it, exactly once", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 105 });
    const id = (r as { orderId: number }).orderId;
    t.svc.setTempo(t.id, 60);
    t.svc.tick(t.id, 5000); // up to bar 14 (close 106, low 105.5): no fill yet
    expect(orderOf(t, id).status).toBe("open");
    t.svc.tick(t.id, 2000); // bar 15 (close 105, low 104.5) triggers
    expect(orderOf(t, id)).toMatchObject({ status: "filled", gross: 10500, commission: 490, fillPrice: 105 });
    expect(t.svc.snapshot(t.id).depots[0].cash).toBe(1_000_000 - 10990);
    t.svc.tick(t.id, 5000); // later bars are lower still: the order is already filled
    expect(t.svc.snapshot(t.id).depots[0].positions[0].qty).toBe(1);
  });

  it("does not evaluate a bar twice when the time has not moved", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 60);
    t.svc.tick(t.id, 3000);
    const again = t.svc.tick(t.id, 0);
    expect(again.newBars).toEqual({});
    expect(again.simulationTime).toBe(D0 + 7 * H + 780);
  });

  it("rejects the second of two buys that no longer fit the cash when they fill", async () => {
    const t = setup({ startCash: 30_000 });
    await t.svc.start(t.id);
    const a = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 105 });
    const b = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 2, limitPrice: 105 });
    expect(a.ok && b.ok).toBe(true); // each fits on its own: 109.90 EUR and 214.90 EUR against 300 EUR
    t.svc.setTempo(t.id, 60);
    t.svc.tick(t.id, 7000);
    expect(orderOf(t, (a as { orderId: number }).orderId).status).toBe("filled");
    expect(orderOf(t, (b as { orderId: number }).orderId).status).toBe("rejected");
    expect(t.svc.snapshot(t.id).depots[0].cash).toBe(30_000 - 10990);
  });

  it("rejects an open sell at fill time when its fees would take the cash below zero", async () => {
    // A commission of exactly 200 EUR (min and max) makes selling one 105 EUR share cost 95 EUR net.
    const t = setup({ fees: { ...DEFAULT_FEES, commissionMin: 20_000, commissionMax: 20_000 } });
    await t.svc.start(t.id);
    t.store.saveBalance(t.depotId, 1000, new Map([["SAP.DE", { qty: 1, cost: 100 }]]));
    const id = t.store.insertOrder(t.depotId, { symbol: "SAP.DE", side: "sell", kind: "limit", qty: 1, limitPrice: 105 }, t.sim.startAt);
    t.svc.setTempo(t.id, 60);
    t.svc.tick(t.id, 7000); // bar 15 reaches the limit: gross 10,500 cents, commission 20,000 cents
    expect(orderOf(t, id).status).toBe("rejected");
    const snap = t.svc.snapshot(t.id);
    expect(snap.depots[0].cash).toBe(1000);
    expect(snap.depots[0].positions).toEqual([{ symbol: "SAP.DE", qty: 1, cost: 100, value: expect.any(Number) }]);
  });

  it("jumps over the hours when every market is closed to the next bar", async () => {
    const t = setup({ startAt: D0 + 8 * H + 1800 });
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 1);
    const r = t.svc.tick(t.id, 1000);
    expect(r.simulationTime).toBe(D0 + 13 * H + 1800 + 60);
    expect(r.newBars["AAPL"].map((b) => b.t)).toEqual([D0 + 13 * H + 1800]);
  });

  it("over the night reports the end of data until the next day is loaded, then jumps to it", async () => {
    const t = setup({ startAt: D0 + 15 * H });
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 1);
    const stuck = t.svc.tick(t.id, 1000);
    expect(stuck.endOfData).toBe(true);
    await expect(t.svc.loadMore(t.id)).resolves.toBe(true);
    const r = t.svc.tick(t.id, 1000);
    expect(r.endOfData).toBe(false);
    expect(r.simulationTime).toBe(D1 + 7 * H + 60);
    expect(r.newBars["SAP.DE"].map((b) => b.t)).toEqual([D1 + 7 * H]);
  });

  it("loadMore says false when there is nothing more to find", async () => {
    const t = setup({ startAt: D1 + 9 * H });
    await t.svc.start(t.id);
    expect(t.svc.tick(t.id, 1000).endOfData).toBe(true);
    await expect(t.svc.loadMore(t.id)).resolves.toBe(false);
  });

  it("loadMore does not ask for days that have not happened yet", async () => {
    const t = setup({ startAt: D1 + 9 * H, now: D1 + 10 * H });
    await t.svc.start(t.id);
    const before = t.calls.length;
    await expect(t.svc.loadMore(t.id)).resolves.toBe(false);
    const asked = t.calls.slice(before);
    expect(asked.length).toBeLessThanOrEqual(3); // today again, never tomorrow
  });

  it("changes nothing at all when writing the new time fails after the fills", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 105 });
    const id = (r as { orderId: number }).orderId;
    t.svc.setTempo(t.id, 60);
    const spy = vi.spyOn(t.store, "setSimulationTime").mockImplementation(() => { throw new Error("boom"); });
    expect(() => t.svc.tick(t.id, 7000)).toThrow("boom");
    spy.mockRestore();
    expect(t.store.getSimulation(t.id)?.simulationTime).toBe(t.sim.startAt);
    expect(orderOf(t, id).status).toBe("open");
    expect(t.svc.snapshot(t.id).depots[0].cash).toBe(1_000_000);
    t.svc.tick(t.id, 7000); // and the same bars are still there to be evaluated afterwards
    expect(orderOf(t, id).status).toBe("filled");
  });

  it("is a no-op on an ended simulation", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.store.endSimulation(t.id);
    const r = t.svc.tick(t.id, 5000);
    expect(r).toMatchObject({ simulationTime: t.sim.startAt, newBars: {}, endOfData: true });
  });

  it("comes back paused with the same time after a restart", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 60);
    t.svc.run(t.id);
    t.svc.tick(t.id, 3000);
    const restarted = t.make();
    expect(restarted.isRunning(t.id)).toBe(false);
    expect(restarted.snapshot(t.id).simulation.simulationTime).toBe(D0 + 7 * H + 780);
    expect(restarted.snapshot(t.id).simulation.tempo).toBe(60);
  });
});

describe("snapshot", () => {
  it("names the holiday that shuts a market on the simulated day, and nothing on a normal day", () => {
    const goodFriday = Date.parse("2026-04-03T09:00:00Z") / 1000;
    const holiday = setup({ startAt: goodFriday });
    expect(holiday.svc.snapshot(holiday.id).venueClosed).toEqual({ XETRA: "Feiertag: Karfreitag", US: "Feiertag: Karfreitag" });
    const normal = setup();
    expect(normal.svc.snapshot(normal.id).venueClosed).toEqual({});
  });

  it("reports prices, the exchange rate, open markets, value and the running flag", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    const snap = t.svc.snapshot(t.id);
    expect(snap.prices["SAP.DE"]).toEqual({ price: 109, barT: D0 + 7 * H + 540 });
    expect(snap.prices["AAPL"]).toBeUndefined();
    expect(snap.fx).toBe(1.1);
    expect(snap.venues).toEqual({ XETRA: true, US: false });
    expect(snap.depots[0].value).toBe(1_000_000 - 11395 + 10900);
    expect(snap.running).toBe(false);
    t.svc.run(t.id);
    expect(t.svc.snapshot(t.id).running).toBe(true);
    t.svc.pause(t.id);
    expect(t.svc.snapshot(t.id).running).toBe(false);
  });

  it("calls a market closed once none of its instruments has traded for five minutes", async () => {
    const t = setup({ startAt: D0 + 8 * H + 1800 });
    await t.svc.start(t.id);
    expect(t.svc.venueOpen("XETRA", D0 + 8 * H + 1800)).toBe(false);
    expect(t.svc.venueOpen("XETRA", D0 + 8 * H + 300)).toBe(true); // last bar finished at 08:00
    expect(t.svc.venueOpen("XETRA", D0 + 8 * H + 301)).toBe(false);
  });

  it("does not let the round-the-clock exchange rate keep a market open", async () => {
    const t = setup({ startAt: D0 + 20 * H });
    await t.svc.start(t.id);
    expect(t.svc.venueOpen("US", D0 + 20 * H)).toBe(false);
    expect(t.svc.venueOpen("XETRA", D0 + 20 * H)).toBe(false);
  });
});

describe("previewOrder", () => {
  it("prices a market order with the numbers a fill would use", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const r = t.svc.previewOrder(t.id, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    expect(r).toMatchObject({ ok: true, cost: { gross: 10905, commission: 490, foreign: 0, total: 11395 } });
    expect((r as { problem?: string }).problem).toBeUndefined();
  });

  it("prices a limit order at its limit price", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const r = t.svc.previewOrder(t.id, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 100 });
    expect(r).toMatchObject({ ok: true, cost: { execPrice: 100, gross: 10000, total: 10490 } });
  });

  it("shows the cost and the problem together when the order would be rejected", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const r = t.svc.previewOrder(t.id, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 10000 });
    expect(r).toMatchObject({ ok: true, problem: expect.stringMatching(/Guthaben/) });
    expect((r as { cost: { total: number } }).cost.total).toBeGreaterThan(1_000_000);
  });

  it("says there is no price yet for an instrument that has not traded", async () => {
    const t = setup();
    await t.svc.start(t.id);
    expect(t.svc.previewOrder(t.id, { symbol: "AAPL", side: "buy", kind: "market", qty: 1 })).toMatchObject({
      ok: false, reason: expect.stringMatching(/Kurs/),
    });
  });

  it("rejects an unknown symbol", async () => {
    const t = setup();
    await t.svc.start(t.id);
    expect(t.svc.previewOrder(t.id, { symbol: "NOPE", side: "buy", kind: "market", qty: 1 }).ok).toBe(false);
  });
});

describe("the clock at low tempo", () => {
  it.each([[1, 2], [5, 10], [30, 60]] as const)("moves tempo %i by %i s in 2 s of real time, in ticks of 250 ms", async (tempo, expected) => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, tempo);
    for (let i = 0; i < 8; i++) t.svc.tick(t.id, 250);
    expect(t.svc.snapshot(t.id).simulation.simulationTime - t.sim.startAt).toBe(expected);
  });
});

describe("the live limit", () => {
  const SEVEN_TEN = D0 + 7 * H + 600;

  it("keeps the simulation time from running past now minus the delay", async () => {
    const t = setup({ now: SEVEN_TEN + 900 + 30 });
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 60);
    expect(t.svc.tick(t.id, 5000).simulationTime).toBe(SEVEN_TEN + 30);
  });

  it("leaves a replay far behind the limit at the tempo that was chosen", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 60);
    expect(t.svc.tick(t.id, 1000).simulationTime).toBe(SEVEN_TEN + 60);
  });

  it("never runs the time backwards, also when the limit is behind it (a clock that stepped back)", async () => {
    const t = setup({ now: SEVEN_TEN + 900 - 500 });
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 60);
    const r = t.svc.tick(t.id, 5000);
    expect(r.simulationTime).toBe(SEVEN_TEN);
    expect(r.newBars).toEqual({});
  });
});

describe("a live simulation", () => {
  const SEVEN_TEN = D0 + 7 * H + 600;

  it("catches up at the catch-up tempo, whatever tempo is stored", async () => {
    const t = setup({ live: true, catchUpTempo: 300 });
    await t.svc.start(t.id);
    expect(t.svc.tick(t.id, 1000).simulationTime).toBe(SEVEN_TEN + 300);
  });

  it("snaps to the limit once it is within the threshold of it", async () => {
    const t = setup({ live: true, now: SEVEN_TEN + 900 + 100 });
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 60);
    expect(t.svc.tick(t.id, 250).simulationTime).toBe(SEVEN_TEN + 100);
  });

  it("reports the phase: catching up, then live; and a replay as replay, then as reached the present", async () => {
    const live = setup({ live: true, now: SEVEN_TEN + 900 + 3600 });
    await live.svc.start(live.id);
    expect(live.svc.snapshot(live.id)).toMatchObject({ phase: "catchup", liveLimit: SEVEN_TEN + 3600, delayS: 900 });
    live.clock.now = SEVEN_TEN + 900 + 100;
    expect(live.svc.snapshot(live.id).phase).toBe("live");

    const replay = setup({ now: SEVEN_TEN + 900 + 3600 });
    await replay.svc.start(replay.id);
    expect(replay.svc.snapshot(replay.id).phase).toBe("replay");
    replay.clock.now = SEVEN_TEN + 900 + 100;
    expect(replay.svc.snapshot(replay.id).phase).toBe("live");
  });
});

describe("the phase of a live simulation when the market is shut", () => {
  it("is live, not catching up, when no bar lies ahead of the clock: there is nothing to catch up on", async () => {
    // The clock stands where the newest bar ends (AAPL, 14:30), the live limit is days ahead.
    const t = setup({ live: true, startAt: D0 + 14 * H + 1800 });
    await t.svc.start(t.id);
    expect(t.svc.snapshot(t.id)).toMatchObject({ phase: "live" });
    expect(t.svc.snapshot(t.id).liveLimit - t.svc.snapshot(t.id).simulation.simulationTime).toBeGreaterThan(3600);
  });

  it("is catching up while bars lie ahead of the clock", async () => {
    const t = setup({ live: true, startAt: D0 + 7 * H + 600 });
    await t.svc.start(t.id);
    expect(t.svc.snapshot(t.id).phase).toBe("catchup");
  });

  it("a replay at the end of its data stays a replay", async () => {
    const t = setup({ startAt: D0 + 14 * H + 1800 });
    await t.svc.start(t.id);
    expect(t.svc.snapshot(t.id).phase).toBe("replay");
  });
});

describe("the data horizon", () => {
  const T0725 = D0 + 7 * H + 25 * 60;
  const T0730 = D0 + 7 * H + 30 * 60;

  /** SAP only, with bars that stop at 07:30 (the last one starts at 07:29). */
  function atTheEdge(opts: SetupOpts = {}) {
    const t = setup({ instruments: [SAP], startAt: T0725, ...opts });
    t.all["SAP.DE"] = t.all["SAP.DE"].filter((b) => b.t < T0730);
    return t;
  }

  it("stops the clock at the newest known bar, and says it is waiting for data", async () => {
    const t = atTheEdge();
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 60);
    // 07:25 plus 360 s would be 07:31, one minute past the last bar (it ends at 07:30).
    const r = t.svc.tick(t.id, 6000);
    expect(r).toMatchObject({ simulationTime: T0730, waitingForData: true, endOfData: false, liveEdge: false });
    // Reaching the horizon exactly is not waiting yet.
    const exact = atTheEdge();
    await exact.svc.start(exact.id);
    exact.svc.setTempo(exact.id, 60);
    expect(exact.svc.tick(exact.id, 5000)).toMatchObject({ simulationTime: T0730, waitingForData: false });
  });

  it("stays a minute behind the newest bar at the edge of the present, where the bars of other instruments may still be missing", async () => {
    const t = atTheEdge({ now: T0730 + 600 + 900 }); // L is 10 minutes after the newest bar
    await t.svc.start(t.id);
    t.svc.setTempo(t.id, 60);
    const r = t.svc.tick(t.id, 5000);
    expect(r).toMatchObject({ simulationTime: T0730 - 60, waitingForData: true, liveEdge: true });
  });

  it("does not skip bars that arrive late: each is evaluated once, and a limit order they trigger fills once", async () => {
    const t = atTheEdge({ now: T0730 + 600 + 900 });
    const full = t.all["SAP.DE"].slice(); // bars up to 07:30
    const everything = setup({ instruments: [SAP] }).all["SAP.DE"]; // the whole of D0 and D1
    await t.svc.start(t.id);
    // Placed at 07:25, the price is 96. Bar 35 (07:35) is the first with a low at or below 85.
    const placed = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 85 });
    expect(placed.ok).toBe(true);
    t.svc.setTempo(t.id, 60);
    expect(t.svc.tick(t.id, 5000).waitingForData).toBe(true);
    expect(orderOf(t, (placed as { orderId: number }).orderId).status).toBe("open");

    // The bars up to 07:40 now arrive, and the present moves on.
    t.all["SAP.DE"] = everything.filter((b) => b.t < D0 + 7 * H + 40 * 60);
    expect(full.length).toBeLessThan(t.all["SAP.DE"].length);
    t.clock.now = D0 + 7 * H + 40 * 60 + 900;
    await expect(t.svc.loadMore(t.id)).resolves.toBe(true);
    for (let i = 0; i < 6; i++) t.svc.tick(t.id, 5000);

    const order = orderOf(t, (placed as { orderId: number }).orderId);
    expect(order).toMatchObject({ status: "filled", fillPrice: 85, filledSim: D0 + 7 * H + 36 * 60 });
    expect(t.svc.snapshot(t.id).depots[0].positions).toEqual([expect.objectContaining({ symbol: "SAP.DE", qty: 1 })]);
  });

  it("has no horizon, and so no live edge, before any bar is known", () => {
    const t = setup();
    t.svc.setTempo(t.id, 60);
    const r = t.svc.tick(t.id, 5000);
    expect(r).toMatchObject({ simulationTime: t.sim.startAt, liveEdge: false });
  });

  it("an ended simulation reports no waiting and no live edge", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.store.endSimulation(t.id);
    expect(t.svc.tick(t.id, 5000)).toMatchObject({ endOfData: true, waitingForData: false, liveEdge: false });
  });
});

describe("resolveLiveStart", () => {
  const SEVEN_TEN = D1 + 7 * H + 600; // SAP's bars on D1 end at 07:10

  it("is the end of the newest bar of the day of the live limit when that is before the limit", async () => {
    const t = setup({ instruments: [SAP], now: D1 + 12 * H });
    await expect(t.svc.resolveLiveStart()).resolves.toBe(SEVEN_TEN);
  });

  it("is the live limit itself when the bars reach it", async () => {
    const t = setup({ instruments: [SAP], now: D1 + 7 * H + 1000 + 900 }); // L = 07:16:40, bars to 07:10
    await expect(t.svc.resolveLiveStart()).resolves.toBe(SEVEN_TEN);
    const t2 = setup({ instruments: [SAP], now: D0 + 7 * H + 1800 + 900 }); // L = 07:30 on D0, bars run to 08:00
    await expect(t2.svc.resolveLiveStart()).resolves.toBe(D0 + 7 * H + 1800);
  });

  it("goes back over days without bars, a Saturday for instance", async () => {
    const t = setup({ instruments: [SAP], now: D1 + 2 * 86400 }); // L is Saturday night
    await expect(t.svc.resolveLiveStart()).resolves.toBe(SEVEN_TEN);
  });

  it("says no_data when none of the last eight days has a bar, and asks for no more days than that", async () => {
    const t = setup({ instruments: [SAP], now: D1 + 12 * H, noDataFor: ["SAP.DE", FX] });
    await expect(t.svc.resolveLiveStart()).rejects.toMatchObject({ kind: "no_data", message: expect.stringMatching(/keine Kurse/) });
    expect(t.calls.length).toBeLessThanOrEqual(16); // 8 days, SAP and the exchange rate
  });

  it("passes a rate limit on instead of walking back", async () => {
    const t = setup({ instruments: [SAP], now: D1 + 12 * H, fail: "rate_limited" });
    await expect(t.svc.resolveLiveStart()).rejects.toMatchObject({ kind: "rate_limited" });
    expect(t.calls.length).toBe(1);
  });
});

describe("loadMore at the data horizon", () => {
  it("finds the first new minute: a bar that starts exactly where the clock stands", async () => {
    const T0730 = D0 + 7 * H + 30 * 60;
    // The present is inside the day from the start: a day that is over is fetched once and never again.
    const t = setup({ instruments: [SAP], startAt: T0730, now: T0730 + 60 });
    const whole = t.all["SAP.DE"].slice();
    t.all["SAP.DE"] = whole.filter((b) => b.t < T0730); // the last bar starts at 07:29 and ends at 07:30
    await t.svc.start(t.id);
    await expect(t.svc.loadMore(t.id)).resolves.toBe(false);

    t.all["SAP.DE"] = whole.filter((b) => b.t < T0730 + 60); // the bar of 07:30 has arrived
    t.clock.now = T0730 + 120;
    await expect(t.svc.loadMore(t.id)).resolves.toBe(true);
  });
});

describe("several depots", () => {
  it("lists every depot in the snapshot", () => {
    const t = setup();
    t.store.createDepot(t.id, "Zweit");
    expect(t.svc.snapshot(t.id).depots.map((d) => d.name)).toEqual(["Depot 1", "Zweit"]);
  });

  it("trades each depot on its own cash and positions", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const second = t.store.createDepot(t.id, "Zweit");
    expect(t.svc.placeOrder(t.id, second.id, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 }).ok).toBe(true);
    const [first, other] = t.svc.snapshot(t.id).depots;
    expect(first.cash).toBe(1_000_000);
    expect(first.positions).toEqual([]);
    expect(other.cash).toBe(1_000_000 - 11395);
    expect(other.positions).toHaveLength(1);
  });

  it("previews against the cash of the chosen depot", async () => {
    const t = setup({ startCash: 30_000 });
    await t.svc.start(t.id);
    const second = t.store.createDepot(t.id, "Zweit");
    t.store.saveBalance(second.id, 1_000, new Map());
    const order = { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 } as const;
    const own = t.svc.previewOrder(t.id, order);
    expect(own.ok && own.problem).toBeFalsy();
    expect(t.svc.previewOrder(t.id, order, second.id)).toMatchObject({ ok: true, problem: expect.any(String) });
  });

  it("writes a curve point per depot when the clock crosses a minute, and none inside a minute", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const second = t.store.createDepot(t.id, "Zweit");
    t.svc.tick(t.id, 30_000); // 30 s at tempo 1: still inside the minute
    expect(t.store.valueCurve(t.depotId)).toHaveLength(1);
    t.svc.tick(t.id, 60_000);
    const curve = t.store.valueCurve(t.depotId);
    expect(curve).toHaveLength(2);
    expect(curve[1].value).toBe(1_000_000);
    expect(t.store.valueCurve(second.id)).toHaveLength(2);
  });

  it("adds depots up to the limit and not to an ended simulation", () => {
    const t = setup();
    for (let n = 2; n <= 8; n++) expect(t.svc.addDepot(t.id)).toMatchObject({ ok: true, depot: { name: `Depot ${n}` } });
    expect(t.svc.addDepot(t.id)).toEqual({ ok: false, reason: "Mehr als 8 Depots gibt es nicht." });
    const u = setup();
    u.store.endSimulation(u.id);
    expect(u.svc.addDepot(u.id)).toEqual({ ok: false, reason: "Die Simulation ist beendet." });
  });

  it("removes a depot but never the last one", () => {
    const t = setup();
    const second = t.store.createDepot(t.id, "Zweit");
    expect(t.svc.removeDepot(t.id, second.id)).toEqual({ ok: true });
    expect(t.svc.removeDepot(t.id, t.depotId)).toEqual({ ok: false, reason: "Das letzte Depot lässt sich nicht löschen." });
    expect(t.svc.removeDepot(t.id, 9999)).toEqual({ ok: false, reason: "Unbekanntes Depot." });
  });
});

describe("allocate", () => {
  const weights = [{ symbol: "SAP.DE", percent: 60 }, { symbol: "AAPL", percent: 40 }];

  it("plans without placing anything on a dry run", async () => {
    const t = setup({ startAt: D0 + 13 * H + 1800 + 600 });
    await t.svc.start(t.id);
    const r = t.svc.allocate(t.id, t.depotId, weights, true);
    expect(r.ok && r.lines.map((l) => l.symbol)).toEqual(["SAP.DE", "AAPL"]);
    expect(t.svc.snapshot(t.id).depots[0].orders).toEqual([]);
  });

  it("places one market order per line and the cash falls by the planned totals", async () => {
    const t = setup({ startAt: D0 + 13 * H + 1800 + 600 }); // both markets have a price; US is open
    await t.svc.start(t.id);
    const r = t.svc.allocate(t.id, t.depotId, weights, false);
    if (!r.ok) throw new Error(r.reason);
    const bought = r.lines.filter((l) => l.qty > 0);
    expect(bought.length).toBeGreaterThan(0);
    const snap = t.svc.snapshot(t.id).depots[0];
    expect(snap.orders).toHaveLength(bought.length);
    const filledTotal = snap.orders.filter((o) => o.status === "filled").length;
    expect(filledTotal).toBeGreaterThan(0);
    expect(snap.cash).toBeGreaterThanOrEqual(0);
  });

  it("merges a symbol given twice and refuses unknown symbols and bad sums", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const r = t.svc.allocate(t.id, t.depotId, [{ symbol: "SAP.DE", percent: 30 }, { symbol: "SAP.DE", percent: 20 }], true);
    expect(r.ok && r.lines).toHaveLength(1);
    expect(r.ok && r.lines[0].percent).toBe(50);
    const bad = t.svc.allocate(t.id, t.depotId, [{ symbol: "NOPE", percent: 10 }], true);
    expect(bad.ok && bad.lines[0]).toMatchObject({ qty: 0, skipped: "Unbekanntes Wertpapier" });
    expect(t.svc.allocate(t.id, t.depotId, [{ symbol: "SAP.DE", percent: 120 }], true)).toMatchObject({ ok: false });
    expect(t.svc.allocate(t.id, 9999, weights, true)).toEqual({ ok: false, reason: "Unbekanntes Depot." });
  });

  it("leaves the orders open while the market is shut, like an order by hand", async () => {
    const t = setup({ startAt: D0 + 3 * H }); // before any bar of the day
    await t.svc.start(t.id);
    const r = t.svc.allocate(t.id, t.depotId, [{ symbol: "SAP.DE", percent: 50 }], false);
    expect(r.ok).toBe(true);
    const snap = t.svc.snapshot(t.id).depots[0];
    expect(snap.cash).toBe(1_000_000);
    expect(snap.orders.every((o) => o.status === "open")).toBe(true);
  });
});

describe("default depot names", () => {
  it("never repeats a name after a depot was deleted", () => {
    const t = setup();
    const two = t.svc.addDepot(t.id);
    t.svc.addDepot(t.id); // Depot 3
    if (!two.ok) throw new Error(two.reason);
    t.svc.removeDepot(t.id, two.depot.id);
    const again = t.svc.addDepot(t.id);
    expect(again.ok && again.depot.name).toBe("Depot 4");
    const names = t.svc.snapshot(t.id).depots.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("curves and evaluation", () => {
  const minutes = (t: ReturnType<typeof setup>, n: number) => {
    for (let k = 0; k < n; k++) t.svc.tick(t.id, 60_000);
  };

  it("has no benchmark until one is chosen, then gives its price at the times of the depot curve", async () => {
    const t = setup();
    await t.svc.start(t.id);
    minutes(t, 5);
    expect(t.svc.curves(t.id).benchmark).toBeNull();
    t.store.setBenchmark(t.id, "SAP.DE");
    const { depots, benchmark } = t.svc.curves(t.id);
    expect(benchmark).toMatchObject({ symbol: "SAP.DE", name: "SAP", currency: "EUR" });
    const times = new Set(depots[0].points.map((p) => p.t));
    expect(benchmark!.points.length).toBeGreaterThan(0);
    for (const p of benchmark!.points) {
      expect(times.has(p.t)).toBe(true);
      expect(p.value).toBe(t.archive.lastCompleteBar("SAP.DE", p.t)!.c);
    }
  });

  it("leaves out benchmark points where the instrument has no bar yet", async () => {
    const t = setup({ startAt: D0 + 3 * H }); // before the first SAP bar of the day
    await t.svc.start(t.id);
    t.store.setBenchmark(t.id, "SAP.DE");
    expect(t.svc.curves(t.id).benchmark!.points).toEqual([]);
  });

  it("evaluates every depot with its own start, fees and breakdown, and the benchmark with the same metrics", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    minutes(t, 3);
    const second = t.store.createDepot(t.id, "Zweit");
    minutes(t, 3);
    t.store.setBenchmark(t.id, "SAP.DE");

    const ev = t.svc.evaluation(t.id);
    expect(ev.depots.map((d) => d.name)).toEqual(["Depot 1", "Zweit"]);
    expect(ev.depots[0].startedAt).toBe(t.sim.startAt);
    expect(ev.depots[1].startedAt).toBe(t.sim.startAt + 180);
    expect(ev.depots[0].fees).toMatchObject({ orders: 1, commission: 490, foreign: 0, total: 490 });
    expect(ev.depots[1].fees.orders).toBe(0);
    expect(ev.depots[0].breakdown.sector.map((s) => s.label)).toContain("Unbekannt");
    expect(ev.depots[1].breakdown.sector).toEqual([{ label: "Guthaben", value: 1_000_000, share: 1 }]);
    expect(ev.benchmark).toMatchObject({ symbol: "SAP.DE" });
    expect(ev.benchmark!.metrics.totalReturn).not.toBeNull();
    expect(ev.correlation.ids).toEqual([t.depotId, second.id]);
    expect(JSON.parse(JSON.stringify(ev))).toBeTruthy();
    expect(ev.note).toMatch(/Spread/);
  });
});

describe("ghost depots", () => {
  const buy = { symbol: "SAP.DE", side: "buy", kind: "market", qty: 2 } as const;

  async function withPosition() {
    const t = setup();
    await t.svc.start(t.id);
    expect(t.svc.placeOrder(t.id, t.depotId, buy).ok).toBe(true);
    return t;
  }

  it("freezes cash and positions of the source and starts its curve at the source's value", async () => {
    const t = await withPosition();
    const source = t.svc.snapshot(t.id).depots[0];
    const r = t.svc.ghostDepot(t.id, t.depotId);
    expect(r).toMatchObject({ ok: true, depot: { name: "Geist von Depot 1", kind: "ghost", cash: source.cash } });
    const ghost = t.svc.snapshot(t.id).depots[1];
    expect(ghost).toMatchObject({ kind: "ghost", cash: source.cash, value: source.value, orders: [] });
    expect(ghost.positions).toEqual(source.positions);
    expect(t.store.valueCurve(ghost.id)).toEqual([{ t: t.sim.startAt, value: source.value }]);
  });

  it("stays frozen when the source trades on, and is revalued at market by ticks", async () => {
    const t = await withPosition();
    const ghostId = (t.svc.ghostDepot(t.id, t.depotId) as { depot: { id: number } }).depot.id;
    expect(t.svc.placeOrder(t.id, t.depotId, { ...buy, side: "sell", qty: 2 }).ok).toBe(true);
    t.svc.tick(t.id, 120_000); // two minutes at tempo 1
    const [source, ghost] = t.svc.snapshot(t.id).depots;
    expect(source.positions).toEqual([]);
    expect(ghost.positions).toHaveLength(1);
    expect(ghost.positions[0].qty).toBe(2);
    const curve = t.store.valueCurve(ghostId);
    expect(curve.length).toBeGreaterThan(1);
    expect(curve.at(-1)!.value).toBe(ghost.value);
  });

  it("is refused without a position, for a ghost, for an ended simulation, at the limit and for an unknown depot", async () => {
    const t = setup();
    await t.svc.start(t.id);
    expect(t.svc.ghostDepot(t.id, t.depotId)).toEqual({ ok: false, reason: "Ein Geisterdepot braucht mindestens eine Position." });
    expect(t.svc.ghostDepot(t.id, 9999)).toEqual({ ok: false, reason: "Unbekanntes Depot." });
    t.svc.placeOrder(t.id, t.depotId, buy);
    const ghost = (t.svc.ghostDepot(t.id, t.depotId) as { depot: { id: number } }).depot;
    expect(t.svc.ghostDepot(t.id, ghost.id)).toEqual({ ok: false, reason: "Von einem Geisterdepot gibt es keinen Geist." });
    for (let n = 3; n <= 8; n++) expect(t.svc.addDepot(t.id).ok).toBe(true);
    expect(t.svc.ghostDepot(t.id, t.depotId)).toEqual({ ok: false, reason: "Mehr als 8 Depots gibt es nicht." });
    t.store.endSimulation(t.id);
    expect(t.svc.ghostDepot(t.id, t.depotId)).toEqual({ ok: false, reason: "Die Simulation ist beendet." });
  });

  it("never trades: order, preview, allocation and cancel are refused", async () => {
    const t = await withPosition();
    const ghost = (t.svc.ghostDepot(t.id, t.depotId) as { depot: { id: number } }).depot;
    const reason = "Ein Geisterdepot handelt nicht.";
    expect(t.svc.placeOrder(t.id, ghost.id, buy)).toEqual({ ok: false, reason });
    expect(t.svc.previewOrder(t.id, buy, ghost.id)).toEqual({ ok: false, reason });
    expect(t.svc.allocate(t.id, ghost.id, [{ symbol: "SAP.DE", percent: 50 }], false)).toEqual({ ok: false, reason });
    expect(t.svc.allocate(t.id, ghost.id, [{ symbol: "SAP.DE", percent: 50 }], true)).toEqual({ ok: false, reason });
    expect(t.store.loadDepot(ghost.id).orders).toEqual([]);
    const open = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 1 });
    expect(open.ok).toBe(true);
  });

  it("can be deleted, but at least one normal depot stays", async () => {
    const t = await withPosition();
    const ghost = (t.svc.ghostDepot(t.id, t.depotId) as { depot: { id: number } }).depot;
    const second = t.svc.addDepot(t.id) as { depot: { id: number } };
    expect(t.svc.removeDepot(t.id, ghost.id)).toEqual({ ok: true });
    t.svc.ghostDepot(t.id, t.depotId);
    expect(t.svc.removeDepot(t.id, t.depotId)).toEqual({ ok: true });
    // only `second` and the ghost are left: the last normal depot cannot go
    expect(t.svc.removeDepot(t.id, second.depot.id)).toEqual({ ok: false, reason: "Das letzte Depot lässt sich nicht löschen." });
  });

  it("takes the first normal depot as default, and kinds show in curves and evaluation", async () => {
    const t = await withPosition();
    const ghost = (t.svc.ghostDepot(t.id, t.depotId) as { depot: { id: number } }).depot;
    const second = t.svc.addDepot(t.id) as { depot: { id: number } };
    t.svc.removeDepot(t.id, t.depotId);
    expect(t.svc.defaultDepotId(t.id)).toBe(second.depot.id);
    expect(t.svc.snapshot(t.id).depots.map((d) => d.kind)).toEqual(["ghost", "normal"]);
    expect(t.svc.curves(t.id).depots.map((d) => [d.id, d.kind])).toEqual([[ghost.id, "ghost"], [second.depot.id, "normal"]]);
    expect(t.svc.evaluation(t.id).depots.map((d) => d.kind)).toEqual(["ghost", "normal"]);
  });
});

describe("bars marked as outliers (#50)", () => {
  const flag = (t: ReturnType<typeof setup>, barT: number) =>
    t.db.prepare("insert into bar_flags (symbol, t, kind, detail) values ('SAP.DE', ?, 'spike', 'test')").run(barT);

  it("does not fire a limit order on a marked bar; the next sound bar does", async () => {
    const t = setup();
    await t.svc.start(t.id);
    flag(t, D0 + 7 * H + 15 * 60); // bar 15: close 105, low 104.5 would trigger the buy limit 105
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 105 });
    const id = (r as { orderId: number }).orderId;
    t.svc.setTempo(t.id, 60);
    t.svc.tick(t.id, 5000); // up to bar 14
    t.svc.tick(t.id, 1000); // bar 15, marked
    expect(orderOf(t, id).status).toBe("open");
    t.svc.tick(t.id, 1000); // bar 16 (close 104, low 103.5)
    expect(orderOf(t, id)).toMatchObject({ status: "filled", fillPrice: 105, filledSim: D0 + 7 * H + 17 * 60 });
  });

  it("prices a market order on the last sound bar", async () => {
    const t = setup();
    await t.svc.start(t.id);
    flag(t, D0 + 7 * H + 9 * 60); // the last bar at the start (close 109)
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    expect(orderOf(t, (r as { orderId: number }).orderId).fillPrice).toBeCloseTo(108 * 1.0005, 3); // bar 8 closed at 108
  });

  it("does not hand a marked bar out as a new bar", async () => {
    const t = setup();
    await t.svc.start(t.id);
    flag(t, D0 + 7 * H + 10 * 60);
    t.svc.setTempo(t.id, 60);
    const r = t.svc.tick(t.id, 3000);
    expect(r.newBars["SAP.DE"].map((b) => b.t)).toEqual([D0 + 7 * H + 660, D0 + 7 * H + 720]);
  });
});

describe("jumps and auto-pause (#30)", () => {
  const T10 = D0 + 7 * H + 600; // the test simulation starts at 07:10 UTC, bar 10 of SAP has just finished

  async function started(opts: SetupOpts = {}) {
    const t = setup(opts);
    await t.svc.start(t.id);
    return t;
  }

  it("goes one candle on: to the end of the next finished bar, with that bar", async () => {
    const t = await started();
    const r = t.svc.jump(t.id, "candle");
    expect(r).toMatchObject({ ok: true, simulationTime: T10 + 60, stopped: null });
    if (r.ok) expect(r.newBars["SAP.DE"].map((b) => b.t)).toEqual([T10]);
    expect(t.store.getSimulation(t.id)?.simulationTime).toBe(T10 + 60);
  });

  it("arrives at the target to the second, also when the market is shut there", async () => {
    const t = await started();
    const r = t.svc.jump(t.id, "hour"); // 08:10 UTC, ten minutes after the last bar of the day in the data
    expect(r).toMatchObject({ ok: true, simulationTime: T10 + 3600, target: T10 + 3600, stopped: null });
  });

  it("stops where a limit order executed on the way, after carrying it out", async () => {
    const t = await started();
    const order = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 105 });
    expect(order.ok).toBe(true);
    const r = t.svc.jump(t.id, "hour");
    // bar 15 (close 105, low 104.5) is the first to reach the limit; it finishes at 07:16
    expect(r).toMatchObject({ ok: true, simulationTime: D0 + 7 * H + 16 * 60, stopped: { rule: "fill" } });
    expect(t.svc.snapshot(t.id).depots[0].positions[0]).toMatchObject({ symbol: "SAP.DE", qty: 1 });
    if (r.ok && r.stopped) expect(r.stopped.reason).toBe("Angehalten: Kauf 1 SAP.DE ausgeführt");
  });

  it("is deterministic: the same jump from the same state ends at the same time with the same bars", async () => {
    const a = await started();
    const b = await started();
    const ra = a.svc.jump(a.id, "hour");
    const rb = b.svc.jump(b.id, "hour");
    expect(ra).toEqual(rb);
  });

  it("refuses a jump in a simulation without a pause, in a live one, and in an ended one", async () => {
    const t = await started();
    t.db.prepare("update simulations set rules_json = ? where id = ?").run(JSON.stringify({ preset: "hardcore", pauseAllowed: false, tempoLocked: true }), t.id);
    expect(t.svc.jump(t.id, "hour")).toMatchObject({ ok: false, reason: expect.stringMatching(/keine Sprünge/) });
    const live = setup({ live: true });
    expect(live.svc.jump(live.id, "hour")).toMatchObject({ ok: false, reason: expect.stringMatching(/Livebetrieb/) });
    const done = await started();
    done.store.endSimulation(done.id);
    expect(done.svc.jump(done.id, "candle")).toMatchObject({ ok: false });
  });

  it("stops at the end of the data instead of waiting for it", async () => {
    const t = await started();
    t.svc.jump(t.id, "day"); // to the Berlin midnight; the data goes on to D1 07:10
    const r = t.svc.jump(t.id, "close"); // Xetra closes at 15:30 UTC the day after
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.simulationTime).toBeLessThanOrEqual(r.target);
  });

  describe("auto-pause", () => {
    const on = (t: Awaited<ReturnType<typeof started>>, p: object) => t.store.setAutoPause(t.id, parseAutoPause(p));

    it("stops once when an order is near its limit, with the reason", async () => {
      const t = await started();
      on(t, { nearLimit: true, nearLimitPct: 0.01 });
      t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 100 });
      const r = t.svc.jump(t.id, "hour");
      // the price falls a point a minute from 110; 101 (bar 19) is within 1 % of 100, the limit is reached one bar later
      expect(r).toMatchObject({ ok: true, simulationTime: D0 + 7 * H + 20 * 60, stopped: { rule: "near" } });
      if (r.ok && r.stopped) expect(r.stopped.reason).toMatch(/^Automatisch angehalten: Kauf-Limit SAP\.DE ist 1,0 % vom Kurs entfernt/);
      // told once: playing on does not stop for the same order again, only for its execution
      const again = t.svc.jump(t.id, "hour");
      expect(again).toMatchObject({ ok: true, stopped: { rule: "fill" } });
    });

    it("stops on a jump of a held title, once, and again only after it calmed down", async () => {
      const t = await started();
      t.store.saveBalance(t.depotId, 900_000, new Map([["SAP.DE", { qty: 5, cost: 50_000 }]]));
      on(t, { jump: true, jumpPct: 0.05, jumpMinutes: 5 });
      const r = t.svc.jump(t.id, "hour");
      // the price falls a point a minute from 110: five minutes earlier it was 5 higher, -5 % is reached when 5/x >= 5 %, at 100 (bar 20: 100 vs 105 = -4.76 %)
      // and then at 95 (bar 25: 95 vs 100 = -5.0 %): the first bar at which the fall over five minutes is at least 5 % is bar 25
      expect(r).toMatchObject({ ok: true, simulationTime: D0 + 7 * H + 26 * 60, stopped: { rule: "jump" } });
      if (r.ok && r.stopped) expect(r.stopped.reason).toBe("Automatisch angehalten: SAP.DE −5,0 % in 5 Minuten");
      const again = t.svc.jump(t.id, "hour"); // still falling at 5 % or more: told once, not at every bar
      expect(again).toMatchObject({ ok: true, stopped: null });
    });

    it("stops on an executed order only when asked for, and a jump always does", async () => {
      const t = await started();
      on(t, { onFill: true });
      t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 105 });
      const tick = t.svc.tick(t.id, 6 * 60 * 1000); // six minutes of real time at tempo 1 = 360 s
      expect(t.svc.snapshot(t.id).depots[0].positions).toHaveLength(1);
      expect(t.svc.autoPauseFor(t.id, tick)).toMatchObject({ rule: "fill", reason: "Automatisch angehalten: Kauf 1 SAP.DE ausgeführt" });
      on(t, { onFill: false });
      expect(t.svc.autoPauseFor(t.id, tick)).toBeNull();
    });

    it("has nothing to say without the pause allowed", async () => {
      const t = await started();
      on(t, { onFill: true });
      t.db.prepare("update simulations set rules_json = ? where id = ?").run(JSON.stringify({ preset: "hardcore", pauseAllowed: false }), t.id);
      t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 109 });
      expect(t.svc.autoPauseFor(t.id, t.svc.tick(t.id, 1000))).toBeNull();
    });
  });

  describe("time lapse tempo", () => {
    it("is refused with an open order, in a live simulation and in a daily one, and allowed otherwise", async () => {
      const t = await started();
      expect(t.svc.setTempo(t.id, 300)).toEqual({ ok: true });
      expect(t.store.getSimulation(t.id)?.tempo).toBe(300);
      t.svc.setTempo(t.id, 60);
      t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 50 });
      expect(t.svc.setTempo(t.id, 120)).toMatchObject({ ok: false, reason: expect.stringMatching(/ohne offene Orders/) });
      expect(t.svc.setTempo(t.id, 30)).toEqual({ ok: true });
    });

    it("drops to 60 when an order is placed during a time lapse", async () => {
      const t = await started();
      t.svc.setTempo(t.id, 300);
      t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "limit", qty: 1, limitPrice: 50 });
      expect(t.store.getSimulation(t.id)?.tempo).toBe(60);
    });
  });
});
