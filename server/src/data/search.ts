import type { Instrument } from "../config.js";
import { MarketDataError } from "./marketdata.js";

export interface SearchHit extends Instrument {
  kind: "EQUITY" | "ETF";
  sector?: string;
}

export interface InstrumentSearch {
  search(q: string): Promise<SearchHit[]>;
}

const CACHE_S = 60;
const CACHE_MAX = 100;

/** Yahoo's exchange codes for the two markets the code knows. Everything else is dropped. */
const PLACES: Record<string, Pick<Instrument, "venue" | "currency">> = {
  GER: { venue: "XETRA", currency: "EUR" },
  NMS: { venue: "US", currency: "USD" },
  NGM: { venue: "US", currency: "USD" },
  NCM: { venue: "US", currency: "USD" },
  NYQ: { venue: "US", currency: "USD" },
  PCX: { venue: "US", currency: "USD" },
  ASE: { venue: "US", currency: "USD" },
  BTS: { venue: "US", currency: "USD" },
};

export function createYahooSearch(fetchFn: typeof fetch = fetch, now: () => number = () => Date.now() / 1000): InstrumentSearch {
  const cache = new Map<string, { at: number; hits: SearchHit[] }>();
  /** The same query asked while it is on its way shares that one request. */
  const inflight = new Map<string, Promise<SearchHit[]>>();

  async function fetchHits(q: string, key: string): Promise<SearchHit[]> {
    {

      const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q.trim())}&quotesCount=10&newsCount=0`;
      let res: Response;
      try {
        res = await fetchFn(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      } catch (err) {
        throw new MarketDataError("network", `search for ${q} failed: ${(err as Error).message}`);
      }
      if (res.status === 429) throw new MarketDataError("rate_limited", "Yahoo answered 429 for the search");
      if (res.status >= 500) throw new MarketDataError("network", `Yahoo answered ${res.status} for the search`);

      let json: any;
      try {
        json = JSON.parse(await res.text());
      } catch {
        throw new MarketDataError("bad_shape", "Yahoo answered something that is not JSON for the search");
      }
      if (!Array.isArray(json?.quotes)) throw new MarketDataError("bad_shape", "Yahoo search answer has no quotes");

      const hits: SearchHit[] = [];
      for (const x of json.quotes) {
        const place = PLACES[x?.exchange];
        if (!place || (x.quoteType !== "EQUITY" && x.quoteType !== "ETF") || typeof x.symbol !== "string") continue;
        const name = String(x.longname ?? x.shortname ?? x.symbol).trim();
        hits.push({
          symbol: x.symbol, name, currency: place.currency, venue: place.venue, kind: x.quoteType,
          ...(x.quoteType === "EQUITY" && typeof x.sector === "string" && x.sector ? { sector: x.sector } : {}),
        });
      }

      cache.delete(key); // so a refreshed entry counts as the newest
      cache.set(key, { at: now(), hits });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      return hits;
    }
  }

  return {
    search(q) {
      const key = q.trim().toLowerCase();
      const held = cache.get(key);
      if (held && now() - held.at < CACHE_S) return Promise.resolve(held.hits);
      const running = inflight.get(key);
      if (running) return running;
      const p = fetchHits(q, key).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
