import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createYahooSearch } from "../src/data/search.js";
import { MarketDataError } from "../src/data/marketdata.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function fetcher(body: string | (() => Response | Promise<Response>)) {
  const urls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return typeof body === "string" ? new Response(body, { status: 200 }) : body();
  }) as typeof fetch;
  return { fn, urls };
}

const quotes = (...q: object[]) => JSON.stringify({ quotes: q });
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof MarketDataError ? err.kind : "other";
  }
  return "none";
};

describe("createYahooSearch", () => {
  it("maps a Xetra hit to venue and currency and takes the long name", async () => {
    const hits = await createYahooSearch(fetcher(fixture("yahoo-search-sap.json")).fn).search("SAP.DE");
    expect(hits).toEqual([
      { symbol: "SAP.DE", name: "SAP SE", currency: "EUR", venue: "XETRA", kind: "EQUITY" },
    ]);
  });

  it("keeps Xetra hits for 'siemens' and drops Frankfurt, Pink Sheets and India", async () => {
    const hits = await createYahooSearch(fetcher(fixture("yahoo-search-siemens.json")).fn).search("siemens");
    expect(hits.map((h) => h.symbol)).toEqual(["ENR.DE", "SIE.DE", "SHL.DE"]);
    expect(hits.find((h) => h.symbol === "SIE.DE")).toMatchObject({ name: "Siemens Aktiengesellschaft", venue: "XETRA" });
  });

  it("maps a US hit to venue US and USD, and takes ETFs, but not futures, currencies or indices", async () => {
    const body = quotes(
      { exchange: "NMS", shortname: "Apple Inc.", longname: "Apple Inc.", quoteType: "EQUITY", symbol: "AAPL" },
      { exchange: "PCX", shortname: "SPDR S&P 500  ", quoteType: "ETF", symbol: "SPY" },
      { exchange: "CME", shortname: "Apple Futures", quoteType: "FUTURE", symbol: "SAAPL=F" },
      { exchange: "CCY", shortname: "EUR/USD", quoteType: "CURRENCY", symbol: "EURUSD=X" },
      { exchange: "SNP", shortname: "S&P 500", quoteType: "INDEX", symbol: "^GSPC" },
    );
    const hits = await createYahooSearch(fetcher(body).fn).search("apple");
    expect(hits).toEqual([
      { symbol: "AAPL", name: "Apple Inc.", currency: "USD", venue: "US", kind: "EQUITY" },
      { symbol: "SPY", name: "SPDR S&P 500", currency: "USD", venue: "US", kind: "ETF" },
    ]);
  });

  it("returns an empty list when nothing matches", async () => {
    expect(await createYahooSearch(fetcher(quotes()).fn).search("zzzzqq")).toEqual([]);
  });

  it("asks for the query, URL-encoded, with a user agent", async () => {
    const f = fetcher(quotes());
    await createYahooSearch(f.fn).search("a b&c");
    expect(f.urls[0]).toContain("/v1/finance/search?q=a%20b%26c");
  });

  it("reports 429 as rate_limited, 5xx and a thrown fetch as network, and junk as bad_shape", async () => {
    const make = (fn: () => Response | Promise<Response>) => createYahooSearch(fetcher(fn).fn).search("x1");
    expect(await kindOf(make(() => new Response("", { status: 429 })))).toBe("rate_limited");
    expect(await kindOf(make(() => new Response("", { status: 503 })))).toBe("network");
    expect(await kindOf(make(() => { throw new Error("boom"); }))).toBe("network");
    expect(await kindOf(make(() => new Response("<html>", { status: 200 })))).toBe("bad_shape");
    expect(await kindOf(make(() => new Response("{}", { status: 200 })))).toBe("bad_shape");
  });

  it("answers the same query once for 60 seconds whatever its case and spaces, and asks again after", async () => {
    let t = 1000;
    const f = fetcher(quotes());
    const search = createYahooSearch(f.fn, () => t);
    await search.search("Siemens");
    await search.search("  siemens ");
    expect(f.urls).toHaveLength(1);
    t += 61;
    await search.search("siemens");
    expect(f.urls).toHaveLength(2);
  });

  it("does not keep a failure", async () => {
    let fail = true;
    const f = fetcher(() => (fail ? new Response("", { status: 429 }) : new Response(quotes(), { status: 200 })));
    const search = createYahooSearch(f.fn, () => 1);
    expect(await kindOf(search.search("abc"))).toBe("rate_limited");
    fail = false;
    expect(await search.search("abc")).toEqual([]);
  });

  it("keeps at most 100 queries and forgets the oldest first", async () => {
    const f = fetcher(quotes());
    const search = createYahooSearch(f.fn, () => 1);
    for (let n = 0; n < 101; n++) await search.search(`q${n}`);
    expect(f.urls).toHaveLength(101);
    await search.search("q100"); // still held
    expect(f.urls).toHaveLength(101);
    await search.search("q0"); // dropped
    expect(f.urls).toHaveLength(102);
  });
});
