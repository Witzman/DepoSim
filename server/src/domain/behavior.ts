import type { BarsAccess, JournalOrder, JournalTrade, SaleContext } from "./journal.js";

const DAY = 86400;
/** Fewer closed trades than this and a figure says "too early" instead of a number. */
export const MIN_BEHAVIOR_TRADES = 10;
/** The time-of-day table needs this many trades. */
export const MIN_HOUR_TRADES = 20;
/** A group inside a comparison (winners, losers, trades after a loss) needs this many. */
export const MIN_GROUP = 3;
/** A buy after a rise of more than this over the last trading days counts as chasing. */
export const CHASE_RISE = 0.05;
export const CHASE_DAYS = 5;

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export interface Disposition {
  /** Closed pieces sold above / below their buy price, summed over all sales. */
  realizedGains: number;
  realizedLosses: number;
  /** Open lots that stood in plus / minus on the day of a sale, summed over all sales. */
  paperGains: number;
  paperLosses: number;
  /** Realized gains over all gains that could have been realized; null when there were none. */
  pgr: number | null;
  plr: number | null;
  /** PGR over PLR; above 1 means gains are taken more readily than losses. */
  ratio: number | null;
  /** Open lots left out because no price was known on the day of a sale. */
  unpriced: number;
  n: number;
  ok: boolean;
}

export interface Group { n: number; medianSeconds: number | null }

export interface Behavior {
  minTrades: number;
  trades: number;
  disposition: Disposition;
  holding: { winners: Group; losers: Group; ok: boolean };
  turnover: {
    orders: number;
    /** Null while the history is shorter than a month: a rate from days would be noise. */
    ordersPerMonth: number | null;
    /** Yearly volume of the buys over the mean depot value; null without a value or under a year of 30 days. */
    yearlyTurnover: number | null;
    feesPerTrade: number | null;
    /** Fees over the gross result of the trades (result before fees); null when that is not above zero. */
    feeShare: number | null;
    ok: boolean;
  };
  chasing: { n: number; momentum: number; pullback: number; momentumShare: number | null; pullbackShare: number | null; ok: boolean };
  afterLoss: {
    n: number;
    medianGapSeconds: number | null;
    baselineGapSeconds: number | null;
    medianSize: number | null;
    baselineSize: number | null;
    ok: boolean;
  };
  timeOfDay: { hours: { hour: number; n: number; wins: number; netPnl: number }[]; ok: boolean; reason: string | null };
  note: string;
}

/** The close of the trading day `days` before the day of `t`, or undefined when the archive has fewer days. */
function closeDaysBefore(bars: BarsAccess, symbol: string, t: number, days: number): number | undefined {
  let from = Math.floor(t / DAY) * DAY;
  let bar;
  for (let i = 0; i < days; i++) {
    bar = bars.lastCompleteBar(symbol, from);
    if (!bar) return undefined;
    from = Math.floor(bar.t / DAY) * DAY;
  }
  return bar?.c;
}

const berlinHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false });
const hourOf = (t: number) => Number(berlinHour.format(t * 1000)) % 24;

/**
 * Patterns in how the trades were made, from the same orders as the journal. Pure; reads prices only up to `s`.
 * Every figure carries its sample size and gives no number under the minimum.
 */
export function analyzeBehavior(input: {
  orders: JournalOrder[];
  trades: JournalTrade[];
  contexts: SaleContext[];
  s: number;
  bars: BarsAccess;
  /** Mean value of the depot in cents over its history, for the turnover; null when unknown. */
  meanValue: number | null;
  /** False for a daily simulation: all orders sit at the same time of day. */
  intraday: boolean;
}): Behavior {
  const { trades, contexts, s, bars } = input;
  const orders = [...input.orders].sort((a, b) => a.filledSim - b.filledSim || a.id - b.id);
  const enough = trades.length >= MIN_BEHAVIOR_TRADES;

  // Disposition effect (Odean 1998): on every day with a sale, the gains and losses that were realized
  // against those that stood on paper and were left open.
  let rg = 0, rl = 0, pg = 0, pl = 0, unpriced = 0;
  for (const c of contexts) {
    for (const p of c.closed) {
      if (p.sellPrice > p.buyPrice) rg++;
      else if (p.sellPrice < p.buyPrice) rl++;
    }
    for (const lot of c.remaining) {
      const bar = bars.lastCompleteBar(lot.symbol, Math.min(c.soldSim, s));
      if (!bar) { unpriced++; continue; }
      if (bar.c > lot.buyPrice) pg++;
      else if (bar.c < lot.buyPrice) pl++;
    }
  }
  const pgr = rg + pg === 0 ? null : rg / (rg + pg);
  const plr = rl + pl === 0 ? null : rl / (rl + pl);
  const disposition: Disposition = {
    realizedGains: rg, realizedLosses: rl, paperGains: pg, paperLosses: pl,
    pgr: pgr === null ? null : round4(pgr), plr: plr === null ? null : round4(plr),
    ratio: pgr !== null && plr !== null && plr > 0 ? round4(pgr / plr) : null,
    unpriced, n: rg + rl, ok: enough && pgr !== null && plr !== null && plr > 0,
  };

  const win = trades.filter((t) => t.netPnl > 0);
  const lose = trades.filter((t) => t.netPnl < 0);
  const holding = {
    winners: { n: win.length, medianSeconds: median(win.map((t) => t.holdSeconds)) },
    losers: { n: lose.length, medianSeconds: median(lose.map((t) => t.holdSeconds)) },
    ok: enough && win.length >= MIN_GROUP && lose.length >= MIN_GROUP,
  };

  const first = orders[0]?.filledSim;
  const spanDays = first === undefined ? 0 : (s - first) / DAY;
  const buys = orders.filter((o) => o.side === "buy");
  const fees = trades.reduce((a, t) => a + t.fees, 0);
  const gross = trades.reduce((a, t) => a + t.netPnl + t.fees, 0);
  const turnover = {
    orders: orders.length,
    ordersPerMonth: spanDays >= 30 ? round4(orders.length / (spanDays / 30.4375)) : null,
    yearlyTurnover:
      spanDays >= 30 && input.meanValue !== null && input.meanValue > 0
        ? round4(buys.reduce((a, o) => a + o.gross, 0) / (spanDays / 365.25) / input.meanValue)
        : null,
    feesPerTrade: trades.length === 0 ? null : Math.round(fees / trades.length),
    feeShare: gross > 0 ? round4(fees / gross) : null,
    ok: enough,
  };

  // Chasing: the rise over the last trading days before each buy.
  let momentum = 0, pullback = 0, measured = 0;
  for (const o of buys) {
    const ref = closeDaysBefore(bars, o.symbol, o.filledSim, CHASE_DAYS);
    if (ref === undefined || ref <= 0) continue;
    measured++;
    const change = o.fillPrice / ref - 1;
    if (change > CHASE_RISE) momentum++;
    else if (change < 0) pullback++;
  }
  const chasing = {
    n: measured, momentum, pullback,
    momentumShare: measured === 0 ? null : round4(momentum / measured),
    pullbackShare: measured === 0 ? null : round4(pullback / measured),
    ok: measured >= MIN_BEHAVIOR_TRADES,
  };

  // After a loss: how soon, and how big, was the next order, against the orders in general.
  const lossSales = new Set<number>();
  const bySell = new Map<number, number>();
  for (const t of trades) bySell.set(t.sellOrderId, (bySell.get(t.sellOrderId) ?? 0) + t.netPnl);
  for (const [id, pnl] of bySell) if (pnl < 0) lossSales.add(id);
  const gaps: number[] = [];
  const sizes: number[] = [];
  const allGaps: number[] = [];
  for (let i = 0; i + 1 < orders.length; i++) allGaps.push(orders[i + 1].filledSim - orders[i].filledSim);
  for (let i = 0; i + 1 < orders.length; i++) {
    if (!lossSales.has(orders[i].id)) continue;
    gaps.push(orders[i + 1].filledSim - orders[i].filledSim);
    sizes.push(orders[i + 1].gross);
  }
  const afterLoss = {
    n: gaps.length,
    medianGapSeconds: median(gaps), baselineGapSeconds: median(allGaps),
    medianSize: median(sizes), baselineSize: median(orders.map((o) => o.gross)),
    ok: enough && gaps.length >= MIN_GROUP,
  };

  const hours = new Map<number, { hour: number; n: number; wins: number; netPnl: number }>();
  for (const t of trades) {
    const h = hourOf(t.openedSim);
    const e = hours.get(h) ?? { hour: h, n: 0, wins: 0, netPnl: 0 };
    e.n++;
    if (t.netPnl > 0) e.wins++;
    e.netPnl += t.netPnl;
    hours.set(h, e);
  }
  const timeOfDay = !input.intraday
    ? { hours: [], ok: false, reason: "Im Tageskurs-Modus gibt es keine Tageszeit." }
    : trades.length < MIN_HOUR_TRADES
      ? { hours: [], ok: false, reason: `Zu wenige Trades: ab ${MIN_HOUR_TRADES} wird nach Stunde der Eröffnung aufgeteilt.` }
      : { hours: [...hours.values()].sort((a, b) => a.hour - b.hour), ok: true, reason: null };

  return {
    minTrades: MIN_BEHAVIOR_TRADES, trades: trades.length,
    disposition, holding, turnover, chasing, afterLoss, timeOfDay,
    note: "Muster, keine Wertung und keine Prognose.",
  };
}
