import { describe, expect, it } from "vitest";
import { afterLossText, chasingText, dispositionText, holdingText, turnoverText } from "../src/behaviorText.js";
import type { Behavior } from "../src/types.js";

const empty: Behavior = {
  minTrades: 10, trades: 12,
  disposition: { realizedGains: 3, realizedLosses: 1, paperGains: 2, paperLosses: 4, pgr: 0.6, plr: 0.2, ratio: 3, unpriced: 0, n: 4, ok: true },
  holding: { winners: { n: 6, medianSeconds: 3600 }, losers: { n: 6, medianSeconds: 36000 }, ok: true },
  turnover: { orders: 24, ordersPerMonth: 4, yearlyTurnover: 2.5, feesPerTrade: 200, feeShare: 0.4, ok: true },
  chasing: { n: 12, momentum: 6, pullback: 3, momentumShare: 0.5, pullbackShare: 0.25, ok: true },
  afterLoss: { n: 4, medianGapSeconds: 600, baselineGapSeconds: 7200, medianSize: 50000, baselineSize: 10000, ok: true },
  timeOfDay: { hours: [], ok: false, reason: "x" },
  note: "n",
};

describe("behaviour texts", () => {
  it("describe the pattern without a verdict", () => {
    expect(dispositionText(empty)).toMatch(/Gewinne wurden eher verkauft als Verluste.*Dispositionseffekt/);
    expect(holdingText(empty)).toMatch(/Verlierer wurden länger gehalten/);
    expect(turnoverText(empty)).toMatch(/40,00\s?% des Ergebnisses/);
    expect(chasingText(empty)).toMatch(/50,00\s?% der Käufe folgten auf einen Anstieg/);
    expect(afterLossText(empty)).toMatch(/schneller und größer/);
  });

  it("say it is too early instead of a sentence about numbers", () => {
    const few: Behavior = { ...empty, trades: 3, disposition: { ...empty.disposition, ok: false }, holding: { ...empty.holding, ok: false }, turnover: { ...empty.turnover, ok: false }, afterLoss: { ...empty.afterLoss, ok: false } };
    expect(dispositionText(few)).toMatch(/Zu früh, um etwas zu sagen/);
    expect(holdingText(few)).toMatch(/Zu früh/);
    expect(turnoverText(few)).toMatch(/Zu früh/);
    expect(afterLossText(few)).toMatch(/Zu früh/);
  });

  it("see no effect when the figures are close", () => {
    const even = { ...empty, disposition: { ...empty.disposition, ratio: 1.0, pgr: 0.3, plr: 0.3 } };
    expect(dispositionText(even)).toMatch(/ähnlich oft/);
  });
});
