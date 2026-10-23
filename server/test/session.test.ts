import { describe, expect, it, vi } from "vitest";
import { createArchive } from "../src/data/archive.js";
import type { MarketDataErrorKind } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";
import { DEFAULT_FEES } from "../src/domain/fees.js";
import { SessionService } from "../src/session.js";
import { createStore } from "../src/store.js";
import { AAPL, D0, D1, FX, H, SAP, makeSource } from "./fakes.js";

interface SetupOpts {
  startAt?: number;
  startCash?: number;
  fail?: MarketDataErrorKind;
  noDataFor?: string[];
  now?: number;
}

function setup(opts: SetupOpts = {}) {
  const { source, calls } = makeSource(opts);
  const now = opts.now ?? D0 + 5 * 86400;
  const db = openDb(":memory:");
  const store = createStore(db);
  const archive = createArchive(db, source, { now: () => now, minGapMs: 0 });
  const make = () => new SessionService({ store, archive, instruments: [SAP, AAPL], fxSymbol: FX, now: () => now });
  const svc = make();
  const sim = store.createSimulation({
    name: "T", startAt: opts.startAt ?? D0 + 7 * H + 600, startCash: opts.startCash ?? 1_000_000, fees: DEFAULT_FEES,
  });
  const depotId = store.listDepots(sim.id)[0].id;
  return { db, store, archive, svc, make, sim, id: sim.id, depotId, calls };
}

const orderOf = (t: ReturnType<typeof setup>, orderId: number) =>
  t.svc.snapshot(t.id).depot.orders.find((o) => o.id === orderId)!;

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
    expect(snap.depot.cash).toBe(1_000_000 - 11395);
    expect(snap.depot.positions).toEqual([{ symbol: "SAP.DE", qty: 1, cost: 11395, value: 10900 }]);
  });

  it("rejects what validateOrder rejects, says why, and stores no order", async () => {
    const t = setup();
    await t.svc.start(t.id);
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 0 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Menge/) });
    expect(t.svc.snapshot(t.id).depot.orders).toEqual([]);
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
    expect(t.svc.snapshot(t.id).depot.cash).toBe(1_000_000);

    t.svc.setTempo(t.id, 60);
    const res = t.svc.tick(t.id, 1000);
    expect(res.simulationTime).toBe(D0 + 7 * H + 60);
    expect(orderOf(t, id)).toMatchObject({ status: "filled", gross: 9980, commission: 490 });
    expect(t.svc.snapshot(t.id).depot.cash).toBe(1_000_000 - 10470);
  });

  it("buys a USD instrument at the exchange rate of that time and pays the foreign fee", async () => {
    const t = setup({ startAt: D0 + 13 * H + 1800 + 600 }); // 13:40, the last finished AAPL bar is no. 9, close 309
    await t.svc.start(t.id);
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "AAPL", side: "buy", kind: "market", qty: 1 });
    expect(r.ok).toBe(true);
    expect(orderOf(t, (r as { orderId: number }).orderId)).toMatchObject({
      status: "filled", gross: 28246, commission: 490, foreignFee: 1490,
    });
    expect(t.svc.snapshot(t.id).depot.cash).toBe(1_000_000 - 30226);
  });

  it("sells a held position and removes it", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    const r = t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "sell", kind: "market", qty: 1 });
    expect(r.ok).toBe(true);
    const snap = t.svc.snapshot(t.id);
    expect(snap.depot.positions).toEqual([]);
    expect(snap.depot.cash).toBe(1_000_000 - 11395 + 10405);
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
    expect(t.svc.snapshot(t.id).depot.cash).toBe(1_000_000 - 10990);
    t.svc.tick(t.id, 5000); // later bars are lower still: the order is already filled
    expect(t.svc.snapshot(t.id).depot.positions[0].qty).toBe(1);
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
    expect(t.svc.snapshot(t.id).depot.cash).toBe(30_000 - 10990);
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
    expect(t.svc.snapshot(t.id).depot.cash).toBe(1_000_000);
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
  it("reports prices, the exchange rate, open markets, value and the running flag", async () => {
    const t = setup();
    await t.svc.start(t.id);
    t.svc.placeOrder(t.id, t.depotId, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    const snap = t.svc.snapshot(t.id);
    expect(snap.prices["SAP.DE"]).toEqual({ price: 109, barT: D0 + 7 * H + 540 });
    expect(snap.prices["AAPL"]).toBeUndefined();
    expect(snap.fx).toBe(1.1);
    expect(snap.venues).toEqual({ XETRA: true, US: false });
    expect(snap.depot.value).toBe(1_000_000 - 11395 + 10900);
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
