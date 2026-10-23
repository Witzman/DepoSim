import { describe, expect, it, vi } from "vitest";
import { createArchive } from "../src/data/archive.js";
import type { MarketDataErrorKind } from "../src/data/marketdata.js";
import { openDb } from "../src/db.js";
import { DEFAULT_FEES } from "../src/domain/fees.js";
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
  const make = () =>
    new SessionService({
      store, archive, instruments: opts.instruments ?? [SAP, AAPL], fxSymbol: FX, now: () => clock.now,
      delayS: opts.delayS, catchUpTempo: opts.catchUpTempo,
    });
  const svc = make();
  const sim = store.createSimulation({
    name: "T", startAt: opts.startAt ?? D0 + 7 * H + 600, startCash: opts.startCash ?? 1_000_000,
    fees: opts.fees ?? DEFAULT_FEES, live: opts.live,
  });
  const depotId = store.listDepots(sim.id)[0].id;
  return { db, store, archive, svc, make, sim, id: sim.id, depotId, calls, all, clock };
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
    expect(snap.depot.cash).toBe(1000);
    expect(snap.depot.positions).toEqual([{ symbol: "SAP.DE", qty: 1, cost: 100, value: expect.any(Number) }]);
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
    expect(t.svc.snapshot(t.id).depot.positions).toEqual([expect.objectContaining({ symbol: "SAP.DE", qty: 1 })]);
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
