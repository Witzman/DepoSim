export const PORT = Number(process.env.PORT ?? 3000);
export const DB_PATH = process.env.DB_PATH ?? "./data/deposim.sqlite";

/** A positive number from the environment, or the default: a typo must not stop the clock. */
function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Settings {
  /** How far behind the present the price source is, in seconds. Not measured yet. */
  liveDelayS: number;
  /** The tempo a live simulation catches up at. */
  catchUpTempo: number;
  /** The shortest time between two refreshes of today's prices, in seconds. */
  liveRefreshS: number;
}

export function readSettings(env: Record<string, string | undefined>): Settings {
  return {
    liveDelayS: positive(env.LIVE_DELAY_S, 900),
    catchUpTempo: positive(env.CATCH_UP_TEMPO, 300),
    liveRefreshS: positive(env.LIVE_REFRESH_S, 60),
  };
}

export const SETTINGS = readSettings(process.env);

export type Venue = "XETRA" | "US";

export interface Instrument {
  symbol: string;
  name: string;
  currency: "EUR" | "USD";
  venue: Venue;
  /** Equity or fund; only a fund is told apart, an equity without a sector is "unbekannt". */
  kind?: "EQUITY" | "ETF";
  /** The sector the source names for an equity. Funds have none. */
  sector?: string;
}

/** How many instruments the person may add to the starting list. Each one is a request per refresh. */
export const MAX_ADDED = 12;

/** The most depots one simulation may hold. */
export const MAX_DEPOTS = 8;

/** The exchange rate is a price series like the others, not a tradable instrument. */
export const FX_SYMBOL = "EURUSD=X";

const us = (symbol: string, name: string, sector?: string): Instrument => ({
  symbol, name, currency: "USD", venue: "US", kind: sector ? "EQUITY" : "ETF", ...(sector ? { sector } : {}),
});
const xetra = (symbol: string, name: string, sector?: string): Instrument => ({
  symbol, name, currency: "EUR", venue: "XETRA", kind: sector ? "EQUITY" : "ETF", ...(sector ? { sector } : {}),
});

export const WATCHLIST: Instrument[] = [
  us("AAPL", "Apple", "Technology"),
  us("MSFT", "Microsoft", "Technology"),
  us("NVDA", "NVIDIA", "Technology"),
  us("TSLA", "Tesla", "Consumer Cyclical"),
  xetra("SAP.DE", "SAP", "Technology"),
  xetra("SIE.DE", "Siemens", "Industrials"),
  xetra("ALV.DE", "Allianz", "Financial Services"),
  xetra("EUNL.DE", "iShares Core MSCI World (Acc)"),
  xetra("VWCE.DE", "Vanguard FTSE All-World (Acc)"),
  xetra("SXR8.DE", "iShares Core S&P 500 (Acc)"),
  xetra("SXRV.DE", "iShares Nasdaq 100 (Acc)"),
  xetra("EXS1.DE", "iShares Core DAX"),
  xetra("EXSA.DE", "iShares STOXX Europe 600"),
  xetra("IS3N.DE", "iShares Core MSCI EM IMI (Acc)"),
  xetra("4GLD.DE", "Xetra-Gold"),
  us("SPY", "SPDR S&P 500"),
  us("QQQ", "Invesco QQQ (Nasdaq 100)"),
  us("VTI", "Vanguard Total Stock Market"),
];
