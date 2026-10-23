import type { Instrument } from "../src/config.js";
import { type Bar, type MarketData, MarketDataError, type MarketDataErrorKind } from "../src/data/marketdata.js";

export const DAY = 86400;
export const H = 3600;
export const D0 = 1792627200; // 2026-10-22 00:00 UTC
export const D1 = D0 + DAY;

export const SAP: Instrument = { symbol: "SAP.DE", name: "SAP", currency: "EUR", venue: "XETRA" };
export const AAPL: Instrument = { symbol: "AAPL", name: "Apple", currency: "USD", venue: "US" };
export const FX = "EURUSD=X";

export const bar = (t: number, c: number): Bar => ({ t, o: c - 0.25, h: c + 0.5, l: c - 0.5, c, v: 10 });
/** Rises 100..110 over ten minutes, then falls one point a minute. */
export const sapClose = (i: number) => (i <= 10 ? 100 + i : 110 - (i - 10));

/**
 * Two UTC days. SAP trades 07:00-08:00 on D0 and 07:00-07:10 on D1, AAPL 13:30-14:30 on D0,
 * and the exchange rate (1.1) runs round the clock like the real one.
 */
export function data(): Record<string, Bar[]> {
  const out: Record<string, Bar[]> = { [SAP.symbol]: [], [AAPL.symbol]: [], [FX]: [] };
  for (let i = 0; i < 60; i++) out[SAP.symbol].push(bar(D0 + 7 * H + i * 60, sapClose(i)));
  for (let i = 0; i < 10; i++) out[SAP.symbol].push(bar(D1 + 7 * H + i * 60, 200 + i));
  for (let i = 0; i < 60; i++) out[AAPL.symbol].push(bar(D0 + 13 * H + 1800 + i * 60, 300 + i));
  for (let k = 0; k < 1440; k++) {
    out[FX].push(bar(D0 + k * 60, 1.1));
    out[FX].push(bar(D1 + k * 60, 1.1));
  }
  return out;
}

export interface SourceOpts {
  fail?: MarketDataErrorKind;
  noDataFor?: string[];
}

/** Serves `data()` like the real adapter: an empty period is a `no_data` error. */
export function makeSource(opts: SourceOpts = {}) {
  const all = data();
  const calls: string[] = [];
  const source: MarketData = {
    async bars(symbol, fromT, toT) {
      calls.push(symbol);
      if (opts.fail) throw new MarketDataError(opts.fail, "fake");
      if (opts.noDataFor?.includes(symbol)) throw new MarketDataError("no_data", "fake");
      const bars = (all[symbol] ?? []).filter((b) => b.t >= fromT && b.t < toT);
      if (bars.length === 0) throw new MarketDataError("no_data", "fake: nothing in that period");
      return bars;
    },
  };
  return { source, calls, all };
}
