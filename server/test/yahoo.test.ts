import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createYahoo, createYahooDaily } from "../src/data/yahoo.js";
import { MarketDataError } from "../src/data/marketdata.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const respond = (body: string, status = 200) => async () => new Response(body, { status });

describe("yahoo adapter", () => {
  it("turns the recorded chart response into minute bars", async () => {
    const bars = await createYahoo(respond(fixture("yahoo-chart-1m.json"))).bars("EUNL.DE", 0, 1);
    expect(bars).toHaveLength(5);
    expect(bars[0]).toEqual({
      t: 1792739040, o: 129.8800048828125, h: 129.8800048828125,
      l: 129.86500549316406, c: 129.86500549316406, v: 0,
    });
    expect(bars[4]).toMatchObject({ t: 1792739280, c: 129.85000610351562, v: 2 });
  });

  it("leaves out a minute with no trades instead of storing it as zero", async () => {
    const bars = await createYahoo(respond(fixture("yahoo-chart-1m-null.json"))).bars("EUNL.DE", 0, 1);
    expect(bars).toHaveLength(4);
    expect(bars.map((b) => b.t)).not.toContain(1792739160);
    for (const b of bars) expect(b.c).toBeGreaterThan(0);
  });

  it("asks for 1-minute bars of the requested period with a browser user agent", async () => {
    let url = "";
    let ua: string | null = null;
    const fetchFn = async (input: URL | RequestInfo, init?: RequestInit) => {
      url = String(input);
      ua = new Headers(init?.headers).get("user-agent");
      return new Response(fixture("yahoo-chart-1m.json"));
    };
    await createYahoo(fetchFn as typeof fetch).bars("EUNL.DE", 1000, 2000);
    expect(url).toContain("/v8/finance/chart/EUNL.DE?");
    expect(url).toContain("interval=1m");
    expect(url).toContain("period1=1000");
    expect(url).toContain("period2=2000");
    expect(ua).toBe("Mozilla/5.0");
  });

  it("escapes the symbol, so a caret or equals sign cannot change the path", async () => {
    let url = "";
    const fetchFn = async (input: URL | RequestInfo) => {
      url = String(input);
      return new Response(fixture("yahoo-chart-1m.json"));
    };
    await createYahoo(fetchFn as typeof fetch).bars("EURUSD=X", 0, 1);
    expect(url).toContain("/chart/EURUSD%3DX?");
  });

  it("says rate_limited on HTTP 429", async () => {
    await expect(createYahoo(respond("", 429)).bars("X", 0, 1)).rejects.toMatchObject({
      name: "MarketDataError", kind: "rate_limited",
    });
  });

  it("says no_data when the result is empty", async () => {
    const body = JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } });
    await expect(createYahoo(respond(body)).bars("X", 0, 1)).rejects.toMatchObject({ kind: "no_data" });
  });

  it("says bad_shape when the answer is not a chart", async () => {
    await expect(createYahoo(respond('{"unexpected":true}')).bars("X", 0, 1)).rejects.toMatchObject({
      kind: "bad_shape",
    });
    await expect(createYahoo(respond("<html>nope</html>")).bars("X", 0, 1)).rejects.toMatchObject({
      kind: "bad_shape",
    });
  });

  it("says network when the request itself fails", async () => {
    const fetchFn = async () => { throw new TypeError("fetch failed"); };
    const err = await createYahoo(fetchFn as typeof fetch).bars("X", 0, 1).catch((e) => e);
    expect(err).toBeInstanceOf(MarketDataError);
    expect(err.kind).toBe("network");
  });
});

describe("yahoo daily adapter", () => {
  const chart = {
    chart: {
      result: [{
        timestamp: [1572595200, 1572854400, 1572940800], // 2019-11-01, 11-04, 11-05 08:00 UTC
        events: {
          dividends: { "1572940800": { amount: 0.25, date: 1572940800 } },
          splits: { "1572854400": { date: 1572854400, numerator: 2, denominator: 1 } },
        },
        indicators: { quote: [{
          open: [10, null, 11], high: [12, null, 13], low: [9, null, 10], close: [11, null, 12], volume: [100, null, 300],
        }] },
      }],
      error: null,
    },
  };

  it("reads days, ex-dates and splits; a day without prices is left out", async () => {
    let url = "";
    const fetchFn = async (input: URL | RequestInfo) => {
      url = String(input);
      return new Response(JSON.stringify(chart));
    };
    const s = await createYahooDaily(fetchFn as typeof fetch).daily("VUSA.DE", 1, 2);
    expect(url).toContain("interval=1d");
    expect(url).toContain("events=div,split");
    expect(s.bars).toEqual([
      { day: "2019-11-01", o: 10, h: 12, l: 9, c: 11, v: 100 },
      { day: "2019-11-05", o: 11, h: 13, l: 10, c: 12, v: 300 },
    ]);
    expect(s.dividends).toEqual([{ exDay: "2019-11-05", amount: 0.25 }]);
    expect(s.splits).toEqual([{ day: "2019-11-04", numerator: 2, denominator: 1 }]);
  });

  it("maps 429 and an unknown symbol like the minute adapter", async () => {
    await expect(createYahooDaily(respond("", 429)).daily("X", 1, 2)).rejects.toMatchObject({ kind: "rate_limited" });
    const none = JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } });
    await expect(createYahooDaily(respond(none, 404)).daily("X", 1, 2)).rejects.toMatchObject({ kind: "no_data" });
  });
});
