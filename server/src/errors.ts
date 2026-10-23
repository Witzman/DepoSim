import { MarketDataError } from "./data/marketdata.js";

/** A message a person can act on, for an error from the price source or anywhere else. */
export function describeError(err: unknown): string {
  if (err instanceof MarketDataError) {
    switch (err.kind) {
      case "rate_limited":
        return "Die Kursquelle drosselt die Abrufe. Bitte in ein paar Minuten noch einmal versuchen.";
      case "network":
        return "Die Kursquelle ist nicht erreichbar.";
      case "bad_shape":
        return "Die Kursquelle hat unerwartet geantwortet.";
      case "no_data":
        return err.message;
    }
  }
  return `Unerwarteter Fehler: ${err instanceof Error ? err.message : String(err)}`;
}
