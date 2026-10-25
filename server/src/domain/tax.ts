import { type Cent, roundCent } from "./money.js";
import { type FundType, FUND_TYPES, TAX_RULES, allowanceFor, effectiveRate } from "./taxrules.js";

export interface TaxSettings {
  enabled: boolean;
  /** 0, 0.08 or 0.09. */
  church: number;
  /** Euro per calendar year; null takes the legal value of that year. */
  allowance: number | null;
  /** Fund type per symbol where the person changed the default. */
  fundTypes: Record<string, FundType>;
}

export const DEFAULT_TAX: TaxSettings = { enabled: false, church: 0, allowance: null, fundTypes: {} };

/** Reads stored settings; anything odd falls back to the default. */
export function parseTaxSettings(raw: unknown): TaxSettings {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try { o = JSON.parse(raw); } catch { o = null; }
  }
  const out: TaxSettings = { ...DEFAULT_TAX, fundTypes: {} };
  if (!o || typeof o !== "object") return out;
  const r = o as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if ((TAX_RULES.church as readonly number[]).includes(r.church as number)) out.church = r.church as number;
  if (typeof r.allowance === "number" && Number.isFinite(r.allowance) && r.allowance >= 0 && r.allowance <= 100000) out.allowance = r.allowance;
  if (r.fundTypes && typeof r.fundTypes === "object") {
    for (const [k, v] of Object.entries(r.fundTypes as Record<string, unknown>)) {
      if ((FUND_TYPES as unknown[]).includes(v)) out.fundTypes[k] = v as FundType;
    }
  }
  return out;
}

/**
 * One taxable event. `stock`: a gain or loss from selling a single share (its own pot). `other`: a result from selling
 * a fund, or a dividend or distribution. `exempt` is the Teilfreistellung of a fund.
 */
export interface TaxEvent {
  t: number;
  pot: "stock" | "other";
  /** Cent, a loss is negative. */
  amount: Cent;
  exempt: number;
}

export interface YearTax {
  year: number;
  stockNet: number;
  otherNet: number;
  /** Losses brought in from earlier years, as negative cents. */
  carryInStock: number;
  carryInOther: number;
  /** What a loss of the general pot took off a gain of the stock pot. */
  offset: number;
  base: number;
  allowance: Cent;
  taxable: number;
  tax: Cent;
  carryOutStock: number;
  carryOutOther: number;
}

const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear();

const adjusted = (e: TaxEvent) => e.amount * (1 - e.exempt);

/** One year from its events and the carried losses. Pure. */
function taxOfYear(year: number, events: TaxEvent[], carry: { stock: number; other: number }, s: TaxSettings): YearTax {
  const stockNet = events.filter((e) => e.pot === "stock").reduce((a, e) => a + adjusted(e), 0);
  const otherNet = events.filter((e) => e.pot === "other").reduce((a, e) => a + adjusted(e), 0);
  let a = stockNet + carry.stock;
  let o = otherNet + carry.other;
  // A loss of the general pot (funds, dividends) may be set against share gains; a share loss only against share gains.
  let offset = 0;
  if (a > 0 && o < 0) {
    offset = Math.min(a, -o);
    a -= offset;
    o += offset;
  }
  const base = Math.max(a, 0) + Math.max(o, 0);
  const allowance = Math.round((s.allowance ?? allowanceFor(year)) * 100);
  const taxable = Math.max(0, base - allowance);
  return {
    year, stockNet: roundCent(stockNet), otherNet: roundCent(otherNet),
    carryInStock: carry.stock, carryInOther: carry.other, offset: roundCent(offset),
    base: roundCent(base), allowance, taxable: roundCent(taxable),
    tax: roundCent(taxable * effectiveRate(s.church)),
    carryOutStock: roundCent(Math.min(a, 0)), carryOutOther: roundCent(Math.min(o, 0)),
  };
}

export interface TaxTimeline {
  years: YearTax[];
  /** The tax owed in total after each event (it can fall again when a later loss is set off). */
  steps: { t: number; cumTax: Cent }[];
  total: Cent;
}

/**
 * Taxes from the realized results, year by year with the allowance of each calendar year and the loss carry-forward
 * between years. The steps give the running total after every event for the curve. Pure.
 */
export function taxTimeline(events: TaxEvent[], settings: TaxSettings): TaxTimeline {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const byYear = new Map<number, TaxEvent[]>();
  for (const e of sorted) byYear.set(yearOf(e.t), [...(byYear.get(yearOf(e.t)) ?? []), e]);
  const years: YearTax[] = [];
  const steps: TaxTimeline["steps"] = [];
  let carry = { stock: 0, other: 0 };
  let paid = 0;
  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const list = byYear.get(year)!;
    for (let i = 0; i < list.length - 1; i++) {
      steps.push({ t: list[i].t, cumTax: paid + taxOfYear(year, list.slice(0, i + 1), carry, settings).tax });
    }
    const full = taxOfYear(year, list, carry, settings);
    steps.push({ t: list[list.length - 1].t, cumTax: paid + full.tax });
    years.push(full);
    paid += full.tax;
    carry = { stock: full.carryOutStock, other: full.carryOutOther };
  }
  return { years, steps, total: paid };
}

/** The cumulative tax owed at time `t`: the last step at or before it, 0 before the first. */
export function taxAt(timeline: TaxTimeline, t: number): Cent {
  let lo = 0;
  let hi = timeline.steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeline.steps[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : timeline.steps[lo - 1].cumTax;
}

/**
 * The tax if the same gain had been held to the end and realized once, in one year with one allowance. A comparison
 * that shows what selling in between cost; interest on the deferred tax is not counted.
 */
export function holdTax(gain: Cent, year: number, settings: TaxSettings): Cent {
  return gain <= 0 ? 0 : taxOfYear(year, [{ t: 0, pot: "other", amount: gain, exempt: 0 }], { stock: 0, other: 0 }, settings).tax;
}
