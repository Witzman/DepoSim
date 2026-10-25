import type { Instrument } from "./config.js";
import { computeMetrics } from "./domain/metrics.js";
import type { JournalTrade, OpenPosition } from "./domain/journal.js";
import { type TaxEvent, type TaxTimeline, holdTax, taxAt, taxTimeline } from "./domain/tax.js";
import { type FundType, TAX_RULES, allowanceFor, effectiveRate } from "./domain/taxrules.js";
import type { TaxReport } from "./sessionTypes.js";
import type { Booking, Simulation } from "./store.js";

const VORAB = {
  computed: false as const,
  reason: "Die Vorabpauschale für thesaurierende Fonds wird nicht berechnet: das Simulationsdepot weiß nicht, ob ein Fonds thesauriert, und Yahoo liefert es nicht.",
};

/**
 * The "after tax" estimate of a depot from what was booked: realized results and distributions taxed year by year, a curve minus
 * the tax owed so far, and the friction of fees and tax. Reads its input only and changes nothing.
 */
export function buildTaxReport(input: {
  sim: Pick<Simulation, "tax" | "simulationTime" | "startCash">;
  trades: JournalTrade[];
  open: OpenPosition[];
  bookings: Booking[];
  instrument: (symbol: string) => Instrument | undefined;
  /** The depot's value curve. */
  gross: { t: number; value: number }[];
  feesTotal: number;
}): TaxReport {
  const { sim, trades, open, bookings, instrument, gross, feesTotal: fees } = input;
  const settings = sim.tax;
  const rules = {
    asOf: TAX_RULES.asOf, rate: effectiveRate(settings.church), church: [...TAX_RULES.church],
    allowance: settings.allowance ?? allowanceFor(new Date(sim.simulationTime * 1000).getUTCFullYear()),
    allowanceIsDefault: settings.allowance === null, sources: [...TAX_RULES.sources],
  };
  if (!settings.enabled) return { settings, enabled: false, rules, vorabpauschale: VORAB, funds: [], report: null };

  const fundOf = (symbol: string): FundType | null =>
    instrument(symbol)?.kind === "ETF" ? (settings.fundTypes[symbol] ?? "equityFund") : null;
  const exempt = (fund: FundType | null) => (fund === null ? 0 : TAX_RULES.partialExemption[fund]);
  const events: TaxEvent[] = [];
  for (const t of trades) {
    const fund = fundOf(t.symbol);
    events.push({ t: t.closedSim, pot: fund === null ? "stock" : "other", amount: t.netPnl, exempt: exempt(fund) });
  }
  for (const b of bookings) {
    if (b.kind !== "dividend" || b.amount === 0) continue;
    events.push({ t: b.t, pot: "other", amount: b.amount, exempt: exempt(fundOf(b.symbol)) });
  }
  const timeline: TaxTimeline = taxTimeline(events, settings);

  const net = gross.map((p) => ({ t: p.t, value: p.value - taxAt(timeline, p.t) }));
  const first = gross[0];
  const last = gross[gross.length - 1];
  const result = first && last ? last.value - first.value : 0;
  const before = result + fees + timeline.total;
  const m = (points: { t: number; value: number }[]) => {
    const x = computeMetrics(points);
    return { totalReturn: x.totalReturn, volatility: x.volatility, sharpe: x.sharpe, maxDrawdown: x.maxDrawdown, basis: x.basis };
  };
  const step = Math.max(1, Math.ceil(gross.length / 300));
  const symbols = new Set([...trades.map((t) => t.symbol), ...open.map((o) => o.symbol), ...bookings.map((b) => b.symbol)]);
  const funds = [...symbols].flatMap((symbol) => {
    const inst = instrument(symbol);
    return inst?.kind === "ETF" ? [{ symbol, name: inst.name, type: settings.fundTypes[symbol] ?? ("equityFund" as FundType), isDefault: settings.fundTypes[symbol] === undefined }] : [];
  });
  const holdYear = new Date((last?.t ?? sim.simulationTime) * 1000).getUTCFullYear();
  const hold = holdTax(Math.max(0, result), holdYear, settings);
  return {
    settings, enabled: true, rules, vorabpauschale: VORAB, funds,
    report: {
      years: timeline.years, total: timeline.total,
      curve: gross.filter((_, i) => i % step === 0 || i === gross.length - 1).map((p) => ({ t: p.t, gross: p.value, net: p.value - taxAt(timeline, p.t) })),
      gross: m(gross), net: m(net),
      friction: { fees, tax: timeline.total, before, share: before > 0 ? (fees + timeline.total) / before : null },
      hold: { tax: hold, difference: timeline.total - hold, gain: Math.max(0, result) },
    },
  };
}
