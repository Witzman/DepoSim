import { type Bar, type DailyData, type DailySeries, type MarketData, MarketDataError, timeoutSignal } from "./marketdata.js";

const isNumberArray = (a: unknown): a is (number | null)[] => Array.isArray(a);

/** One chart request: the HTTP and shape checks that minute and daily bars share. Returns result[0]. */
async function chartResult(fetchFn: typeof fetch, symbol: string, url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: timeoutSignal() });
  } catch (err) {
    throw new MarketDataError("network", `request for ${symbol} failed: ${(err as Error).message}`);
  }
  if (res.status === 429) throw new MarketDataError("rate_limited", `Yahoo answered 429 for ${symbol}`);
  if (res.status >= 500) throw new MarketDataError("network", `Yahoo answered ${res.status} for ${symbol}`);

  let json: any;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new MarketDataError("bad_shape", `Yahoo answered something that is not JSON for ${symbol}`);
  }

  const chart = json?.chart;
  if (!chart || typeof chart !== "object") {
    throw new MarketDataError("bad_shape", `Yahoo answer for ${symbol} has no chart`);
  }
  const result = chart.result;
  if (result === null || (Array.isArray(result) && result.length === 0)) {
    throw new MarketDataError("no_data", `Yahoo has no data for ${symbol}`);
  }
  if (!Array.isArray(result)) {
    throw new MarketDataError("bad_shape", `Yahoo answer for ${symbol} has no result list`);
  }

  const r = result[0];
  if (!r?.timestamp) {
    // A period with no trading comes back with a meta block and no timestamps.
    throw new MarketDataError("no_data", `Yahoo has no bars for ${symbol} in that period`);
  }
  return r;
}

export function createYahoo(fetchFn: typeof fetch = fetch): MarketData {
  return {
    async bars(symbol, fromT, toT) {
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?interval=1m&period1=${fromT}&period2=${toT}`;

      const r = await chartResult(fetchFn, symbol, url);
      const q = r.indicators?.quote?.[0];
      const ts = r.timestamp;
      if (!q || !isNumberArray(ts) || !isNumberArray(q.open) || !isNumberArray(q.high) ||
          !isNumberArray(q.low) || !isNumberArray(q.close) || !isNumberArray(q.volume) ||
          [q.open, q.high, q.low, q.close, q.volume].some((a) => a.length !== ts.length)) {
        throw new MarketDataError("bad_shape", `Yahoo bars for ${symbol} are not parallel arrays`);
      }

      const bars: Bar[] = [];
      for (let i = 0; i < ts.length; i++) {
        const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
        // A minute with no trades is null in every field. It is not a price of zero.
        if (ts[i] === null || o === null || h === null || l === null || c === null) continue;
        bars.push({ t: ts[i] as number, o, h, l, c, v: q.volume[i] ?? 0 });
      }
      return bars;
    },
  };
}

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** The same chart endpoint with `interval=1d` and `events=div,split`. */
export function createYahooDaily(fetchFn: typeof fetch = fetch): DailyData {
  return {
    async daily(symbol, fromT, toT) {
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?interval=1d&period1=${fromT}&period2=${toT}&events=div,split`;
      const r = await chartResult(fetchFn, symbol, url);
      const q = r.indicators?.quote?.[0];
      const ts = r.timestamp;
      if (!q || !isNumberArray(ts) || !isNumberArray(q.open) || !isNumberArray(q.high) ||
          !isNumberArray(q.low) || !isNumberArray(q.close) || !isNumberArray(q.volume) ||
          [q.open, q.high, q.low, q.close, q.volume].some((a) => a.length !== ts.length)) {
        throw new MarketDataError("bad_shape", `Yahoo daily bars for ${symbol} are not parallel arrays`);
      }
      const out: DailySeries = { bars: [], dividends: [], splits: [] };
      for (let i = 0; i < ts.length; i++) {
        const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
        // Yahoo sometimes has a day with the timestamp and no prices. It is left out, not stored as zero.
        if (ts[i] === null || o === null || h === null || l === null || c === null) continue;
        out.bars.push({ day: dayOf(ts[i] as number), o, h, l, c, v: q.volume[i] ?? 0 });
      }
      for (const d of Object.values<any>(r.events?.dividends ?? {})) {
        if (typeof d?.date === "number" && typeof d?.amount === "number" && d.amount > 0) {
          out.dividends.push({ exDay: dayOf(d.date), amount: d.amount });
        }
      }
      for (const sp of Object.values<any>(r.events?.splits ?? {})) {
        if (typeof sp?.date === "number") {
          out.splits.push({ day: dayOf(sp.date), numerator: Number(sp.numerator), denominator: Number(sp.denominator) });
        }
      }
      out.dividends.sort((a, b) => a.exDay.localeCompare(b.exDay));
      out.splits.sort((a, b) => a.day.localeCompare(b.day));
      return out;
    },
  };
}
