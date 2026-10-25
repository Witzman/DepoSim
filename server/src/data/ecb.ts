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

// The ECB's statistical data warehouse, all currencies, one value per day. The old files at /stats/eurofxref/ are gone or broken
// (measured 2026-10-25): `eurofxref-hist-90d.csv` answers 404, and `eurofxref-hist.csv` ends in 2010 with two rows of test numbers
// (2010-02-12 and 2010-02-14, USD 5 and 2). The history is 15 MB of long-format CSV (about 3 s), "recent" is 0.5 MB.
const BASE = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?detail=dataonly&format=csvdata";
const FIRST_DAY = "1999-01-01";
const RECENT_DAYS = 100;

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

/**
 * The warehouse answer: `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE`, one line per currency and day.
 * Returns the rows oldest first, like `parseEcbCsv`.
 */
export function parseEcbSdmx(text: string): EcbRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0]?.split(",").map((c) => c.trim());
  const ccyAt = header?.indexOf("CURRENCY") ?? -1;
  const dayAt = header?.indexOf("TIME_PERIOD") ?? -1;
  const rateAt = header?.indexOf("OBS_VALUE") ?? -1;
  if (ccyAt < 0 || dayAt < 0 || rateAt < 0) throw new MarketDataError("bad_shape", "ECB answer has no CURRENCY, TIME_PERIOD and OBS_VALUE columns");
  const byDay = new Map<string, Record<string, number>>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const [ccy, day, raw] = [cells[ccyAt]?.trim(), cells[dayAt]?.trim(), cells[rateAt]?.trim()];
    if (!/^[A-Z]{3}$/.test(ccy) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new MarketDataError("bad_shape", `ECB row is not a rate: ${line.slice(0, 60)}`);
    if (raw === "" || raw === "NaN") continue;
    const rate = Number(raw);
    if (!Number.isFinite(rate)) throw new MarketDataError("bad_shape", `ECB rate for ${ccy} on ${day} is not a number`);
    if (rate <= 0) continue;
    if (!byDay.has(day)) byDay.set(day, {});
    byDay.get(day)![ccy] = rate;
  }
  if (byDay.size === 0) throw new MarketDataError("bad_shape", "ECB answer has no rows");
  return [...byDay].map(([day, rates]) => ({ day, rates })).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export function createEcb(fetchFn: typeof fetch = fetch): EcbSource {
  return {
    async fetch(range) {
      let res: Response;
      try {
        const start = range === "full" ? FIRST_DAY : new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
        res = await fetchFn(`${BASE}&startPeriod=${start}`, { signal: timeoutSignal() });
      } catch (err) {
        throw new MarketDataError("network", `request to the ECB failed: ${(err as Error).message}`);
      }
      if (res.status === 429) throw new MarketDataError("rate_limited", "the ECB answered 429");
      if (res.status >= 500) throw new MarketDataError("network", `the ECB answered ${res.status}`);
      if (!res.ok) throw new MarketDataError("bad_shape", `the ECB answered ${res.status}`);
      return parseEcbSdmx(await res.text());
    },
  };
}
