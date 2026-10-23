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
}

/** The exchange rate is a price series like the others, not a tradable instrument. */
export const FX_SYMBOL = "EURUSD=X";

const us = (symbol: string, name: string): Instrument => ({ symbol, name, currency: "USD", venue: "US" });
const xetra = (symbol: string, name: string): Instrument => ({ symbol, name, currency: "EUR", venue: "XETRA" });

export const WATCHLIST: Instrument[] = [
  us("AAPL", "Apple"),
  us("MSFT", "Microsoft"),
  us("NVDA", "NVIDIA"),
  us("TSLA", "Tesla"),
  xetra("SAP.DE", "SAP"),
  xetra("SIE.DE", "Siemens"),
  xetra("ALV.DE", "Allianz"),
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
