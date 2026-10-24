import type { JournalTrade } from "./types.js";

/** The fall from the running peak at every point, in percent (0 or negative). A peak of zero or less has no percent. */
export function underwater(points: { t: number; value: number }[]): { t: number; pct: number }[] {
  const out: { t: number; pct: number }[] = [];
  let peak = -Infinity;
  for (const p of points) {
    peak = Math.max(peak, p.value);
    if (peak > 0) out.push({ t: p.t, pct: (p.value / peak - 1) * 100 });
  }
  return out;
}

export interface TradeStats {
  n: number;
  wins: number;
  losses: number;
  /** Cents. */
  netTotal: number;
  /** Mean of the winning and of the losing trades, cents (the loss is negative). Null when there is none. */
  avgWin: number | null;
  avgLoss: number | null;
  /** Average win over the size of the average loss. */
  payoff: number | null;
  /** Gross profit over gross loss. Null without a loss. */
  profitFactor: number | null;
  /** Mean result per trade, cents. */
  expectancy: number | null;
  best: number | null;
  worst: number | null;
  /** The most losing trades in a row, in the order they were closed. */
  longestLosingStreak: number;
}

export function tradeStats(trades: JournalTrade[]): TradeStats {
  const ordered = [...trades].sort((a, b) => a.closedSim - b.closedSim || a.sellOrderId - b.sellOrderId);
  const wins = ordered.filter((t) => t.netPnl > 0);
  const losses = ordered.filter((t) => t.netPnl < 0);
  const sum = (xs: JournalTrade[]) => xs.reduce((a, t) => a + t.netPnl, 0);
  const grossWin = sum(wins);
  const grossLoss = sum(losses);
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  let streak = 0;
  let longest = 0;
  for (const t of ordered) {
    streak = t.netPnl < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  return {
    n: ordered.length,
    wins: wins.length,
    losses: losses.length,
    netTotal: sum(ordered),
    avgWin,
    avgLoss,
    payoff: avgWin !== null && avgLoss !== null ? avgWin / -avgLoss : null,
    profitFactor: losses.length ? grossWin / -grossLoss : null,
    expectancy: ordered.length ? sum(ordered) / ordered.length : null,
    best: ordered.length ? Math.max(...ordered.map((t) => t.netPnl)) : null,
    worst: ordered.length ? Math.min(...ordered.map((t) => t.netPnl)) : null,
    longestLosingStreak: longest,
  };
}
