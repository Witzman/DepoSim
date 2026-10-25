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

/** For a response or a message to the page: the text of a source error is meant for people, the text of any other error is not (paths, SQL). */
export function publicError(err: unknown): string {
  return err instanceof MarketDataError ? describeError(err) : "Unerwarteter Fehler. Näheres steht im Protokoll des Servers.";
}
