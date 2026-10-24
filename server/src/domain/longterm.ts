import { type Cent, roundCent } from "./money.js";
import { type FeeConfig, previewCost } from "./fees.js";

/** One trading day in EUR. `day` is "YYYY-MM-DD" (UTC date of the bar). */
export interface DailyBar {
  day: string;
  o: number;
  c: number;
}

/** A distribution. Yahoo gives the ex-date only; the payment date is ASSUMED to be the ex-day. */
export interface DividendEvent {
  exDay: string;
  /** EUR per share. */
  amount: number;
}

export interface LongtermInput {
  /** Trading days, oldest first. Days without a price are simply not in the list. */
  bars: DailyBar[];
  dividends: DividendEvent[];
  /** The first buy happens on the first bar on or after this day. */
  startDay: string;
  startCash: Cent;
  fees: FeeConfig;
}

export interface LongtermPoint {
  day: string;
  /** Shares x close + cash, in cent. */
  value: Cent;
}

export interface LongtermResult {
  points: LongtermPoint[];
  firstBuyDay: string | null;
  lastDay: string | null;
  startCash: Cent;
  finalValue: Cent;
  /** Ratio, 0.5 means +50 %. */
  totalReturn: number;
  /** Distributions received, gross: no withholding tax is modelled (taxes are a non-goal). */
  dividendsReceived: Cent;
  /** Buys after a distribution that bought at least one share. */
  reinvestments: number;
  /** Distributions whose reinvestment could not buy a whole share after fees. */
  skippedReinvestments: number;
  /** Commission of every buy, the first one included. */
  feesPaid: Cent;
  /** Cost of the spread of every buy (execution price against the open). Already inside the share price paid. */
  spreadPaid: Cent;
  leftoverCash: Cent;
  shares: number;
}

/** The most whole shares whose total cost (price, spread, commission) fits into `cash`. */
function affordable(open: number, cash: Cent, fees: FeeConfig) {
  const ref = { price: open, currency: "EUR" as const };
  let qty = Math.floor(cash / (open * (1 + fees.spreadPct) * 100));
  while (qty > 0) {
    const cost = previewCost("buy", qty, ref, "market", undefined, fees);
    if (cost.total <= cash) return { qty, cost };
    qty--;
  }
  return { qty: 0, cost: null };
}

/**
 * A buy-and-hold depot over daily prices, every distribution reinvested.
 * Rules: the first buy is at the open of the first bar on or after `startDay`; a distribution
 * is credited on its ex-day for the shares held before that day's trading; the cash (that and
 * any leftover) is spent at the open of the next bar after the ex-day, with the app's fee model.
 */
export function simulateLongterm(input: LongtermInput): LongtermResult {
  const { fees, startCash } = input;
  const dividends = new Map<string, number>();
  for (const d of input.dividends) dividends.set(d.exDay, (dividends.get(d.exDay) ?? 0) + d.amount);
  // Ex-days without a bar are credited on the next bar: the shares are the same in between.
  const exDays = [...dividends.keys()].sort();
  let nextEx = 0;

  let cash: Cent = startCash;
  let shares = 0;
  let started = false;
  let pending: string[] = []; // ex-days credited and not yet offered to a buy
  const out: LongtermResult = {
    points: [], firstBuyDay: null, lastDay: null, startCash, finalValue: startCash, totalReturn: 0,
    dividendsReceived: 0, reinvestments: 0, skippedReinvestments: 0, feesPaid: 0, spreadPaid: 0, leftoverCash: startCash, shares: 0,
  };

  const buy = (open: number) => {
    const { qty, cost } = affordable(open, cash, fees);
    if (qty === 0 || !cost) return false;
    cash -= cost.total;
    shares += qty;
    out.feesPaid += cost.commission;
    out.spreadPaid += cost.gross - roundCent(qty * open * 100);
    return true;
  };

  for (const bar of input.bars) {
    if (!(bar.o > 0) || !(bar.c > 0)) continue;
    if (!started) {
      if (bar.day < input.startDay) continue;
      started = true;
      out.firstBuyDay = bar.day;
      buy(bar.o);
    } else {
      // Distributions of days up to and including this one, for the shares held before today's buys.
      while (nextEx < exDays.length && exDays[nextEx] <= bar.day) {
        const ex = exDays[nextEx++];
        if (out.firstBuyDay === null || ex <= out.firstBuyDay) continue; // before the first buy: no shares
        const credit = roundCent(shares * dividends.get(ex)! * 100);
        cash += credit;
        out.dividendsReceived += credit;
        pending.push(ex);
      }
      // A distribution is offered to a buy on the first bar after its ex-day, all due ones in one buy.
      const due = pending.filter((ex) => ex < bar.day);
      if (due.length > 0) {
        if (buy(bar.o)) out.reinvestments++;
        else out.skippedReinvestments += due.length;
        pending = pending.filter((ex) => ex >= bar.day);
      }
    }
    out.points.push({ day: bar.day, value: roundCent(shares * bar.c * 100) + cash });
    out.lastDay = bar.day;
  }

  out.shares = shares;
  out.leftoverCash = cash;
  out.finalValue = out.points.length ? out.points[out.points.length - 1].value : startCash;
  out.totalReturn = startCash > 0 ? (out.finalValue - startCash) / startCash : 0;
  return out;
}
