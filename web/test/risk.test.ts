import { describe, expect, it } from "vitest";
import { tradeStats, underwater } from "../src/risk.js";
import type { JournalTrade } from "../src/types.js";

const trade = (id: number, netPnl: number): JournalTrade => ({
  key: `${id}:0`, symbol: "SAP.DE", qty: 1, buyOrderId: 0, sellOrderId: id, openedSim: 0, closedSim: id * 100, holdSeconds: 60,
  buyPrice: 1, sellPrice: 1, buyCost: 1, sellProceeds: 1, fees: 0, netPnl, netPct: null, note: null,
});

describe("underwater", () => {
  it("is the fall from the running peak in percent", () => {
    const r = underwater([100, 120, 90, 120, 130].map((value, t) => ({ t, value })));
    expect(r.map((p) => p.pct)).toEqual([0, 0, -25, 0, 0]);
  });
  it("is empty for no points and leaves out points under a peak of zero", () => {
    expect(underwater([])).toEqual([]);
    expect(underwater([{ t: 1, value: 0 }, { t: 2, value: 10 }])).toEqual([{ t: 2, pct: 0 }]);
  });
});

describe("tradeStats", () => {
  it("is empty and null for no trades", () => {
    const s = tradeStats([]);
    expect(s).toMatchObject({ n: 0, netTotal: 0, avgWin: null, avgLoss: null, payoff: null, profitFactor: null, expectancy: null, best: null, worst: null, longestLosingStreak: 0 });
  });
  it("measures wins, losses, payoff, profit factor and expectancy", () => {
    const s = tradeStats([trade(1, 300), trade(2, -100), trade(3, 100), trade(4, -200)]);
    expect(s.n).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.netTotal).toBe(100);
    expect(s.avgWin).toBe(200);
    expect(s.avgLoss).toBe(-150);
    expect(s.payoff).toBeCloseTo(200 / 150, 10);
    expect(s.profitFactor).toBeCloseTo(400 / 300, 10);
    expect(s.expectancy).toBe(25);
    expect(s.best).toBe(300);
    expect(s.worst).toBe(-200);
  });
  it("has no profit factor without a loss", () => {
    const s = tradeStats([trade(1, 50), trade(2, 70)]);
    expect(s.profitFactor).toBeNull();
    expect(s.payoff).toBeNull();
  });
  it("counts the longest losing streak in closing order", () => {
    // given out of order: closed 1:-1, 2:-1, 3:+1, 4:-1, 5:-1, 6:-1
    const s = tradeStats([trade(6, -1), trade(3, 1), trade(1, -1), trade(5, -1), trade(2, -1), trade(4, -1)]);
    expect(s.longestLosingStreak).toBe(3);
  });
  it("does not count a break-even trade as a loss", () => {
    expect(tradeStats([trade(1, -5), trade(2, 0), trade(3, -5)]).longestLosingStreak).toBe(1);
  });
});
