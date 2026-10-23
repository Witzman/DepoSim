export const PORT = Number(process.env.PORT ?? 3000);
export const DB_PATH = process.env.DB_PATH ?? "./data/deposim.sqlite";

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
