import { MarketDataError, timeoutSignal } from "./marketdata.js";

/** One publication day of the ECB euro reference rates: units of foreign currency per 1 EUR. */
export interface EcbRow {
  day: string;
  rates: Record<string, number>;
}

export interface EcbSource {
  /** "full": everything since 1999 (about 700 KB). "recent": the last 90 days. Oldest row first. */
  fetch(range: "full" | "recent"): Promise<EcbRow[]>;
}

const BASE = "https://www.ecb.europa.eu/stats/eurofxref/";
// `eurofxref-hist-90d.csv` answers 404 since 2026-10-25 (measured; the ECB took it down, the .xml twin and the full file stay).
// "recent" therefore reads the full file and keeps the last 90 days.
const FILE = "eurofxref-hist.csv";
const RECENT_DAYS = 90;

/**
 * The ECB file: a header `Date,USD,JPY,...,` and one row per publication day, newest first, every
 * line ending in a comma. A currency without a rate that day is `N/A` (or, once, `0`). Anything else is not this file.
 */
export function parseEcbCsv(text: string): EcbRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0]?.split(",").map((c) => c.trim()).filter((c) => c !== "");
  if (!header || header[0] !== "Date" || header.length < 2 || !header.slice(1).every((c) => /^[A-Z]{3}$/.test(c))) {
    throw new MarketDataError("bad_shape", "ECB answer has no Date header with currency columns");
  }
  const rows: EcbRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[0])) throw new MarketDataError("bad_shape", `ECB row has no date: ${line.slice(0, 40)}`);
    const rates: Record<string, number> = {};
    for (let i = 1; i < header.length; i++) {
      const cell = cells[i] ?? "";
      if (cell === "" || cell === "N/A") continue;
      const rate = Number(cell);
      if (!Number.isFinite(rate)) throw new MarketDataError("bad_shape", `ECB rate for ${header[i]} on ${cells[0]} is not a number`);
      // The file has a 0 for ISK on 2009-11-20 (measured 2026-10-25); a rate of zero or less is no rate.
      if (rate > 0) rates[header[i]] = rate;
    }
    rows.push({ day: cells[0], rates });
  }
  if (rows.length === 0) throw new MarketDataError("bad_shape", "ECB answer has no rows");
  return rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export function createEcb(fetchFn: typeof fetch = fetch): EcbSource {
  return {
    async fetch(range) {
      let res: Response;
      try {
        res = await fetchFn(BASE + FILE, { signal: timeoutSignal() });
      } catch (err) {
        throw new MarketDataError("network", `request to the ECB failed: ${(err as Error).message}`);
      }
      if (res.status === 429) throw new MarketDataError("rate_limited", "the ECB answered 429");
      if (res.status >= 500) throw new MarketDataError("network", `the ECB answered ${res.status}`);
      if (!res.ok) throw new MarketDataError("bad_shape", `the ECB answered ${res.status}`);
      const rows = parseEcbCsv(await res.text());
      if (range === "full") return rows;
      const cutoff = new Date(Date.parse(rows[rows.length - 1].day) - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
      return rows.filter((r) => r.day >= cutoff);
    },
  };
}
