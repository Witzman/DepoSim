import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MarketDataError } from "../src/data/marketdata.js";
import { createEcb, parseEcbCsv } from "../src/data/ecb.js";

const CSV = readFileSync(new URL("./fixtures/ecb-hist.csv", import.meta.url), "utf8");

describe("parseEcbCsv", () => {
  it("reads the rows oldest first and skips N/A and the trailing comma", () => {
    const rows = parseEcbCsv(CSV);
    expect(rows.map((r) => r.day)).toEqual(["2026-10-16", "2026-10-19", "2026-10-22", "2026-10-23"]);
    expect(rows[0].rates).toEqual({ USD: 1.065, JPY: 163, BGN: 1.9558, CZK: 24.9 });
    expect(rows[1].rates.JPY).toBeUndefined(); // N/A
    expect(rows[3].rates.CZK).toBeUndefined();
  });

  it("treats a rate of zero as no rate (the real file has one for ISK)", () => {
    expect(parseEcbCsv("Date,USD,ISK,\n2009-11-20,1.48,0,\n")[0].rates).toEqual({ USD: 1.48 });
  });

  it("refuses an answer that is not the ECB file", () => {
    for (const text of ["", "<html>no</html>", "Date,USD,\n", "Datum,USD,\n2026-10-16,1.0,\n", "Date,USD,\nyesterday,1.0,\n", "Date,USD,\n2026-10-16,abc,\n"]) {
      expect(() => parseEcbCsv(text), text).toThrow(MarketDataError);
      try {
        parseEcbCsv(text);
      } catch (e) {
        expect((e as MarketDataError).kind).toBe("bad_shape");
      }
    }
  });
});

describe("createEcb", () => {
  const answer = (status: number, body = CSV) => (async () => new Response(body, { status })) as typeof fetch;

  it("asks the full file or the 90 days file", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => (urls.push(url), new Response(CSV))) as unknown as typeof fetch;
    const ecb = createEcb(fetchFn);
    await ecb.fetch("full");
    await ecb.fetch("recent");
    expect(urls).toEqual([
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.csv",
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.csv",
    ]);
  });

  it("names the kind of failure", async () => {
    const kind = async (f: typeof fetch) => (await createEcb(f).fetch("full").catch((e: MarketDataError) => e)) as MarketDataError;
    expect((await kind(answer(429))).kind).toBe("rate_limited");
    expect((await kind(answer(503))).kind).toBe("network");
    expect((await kind(answer(404))).kind).toBe("bad_shape");
    expect((await kind((async () => { throw new Error("down"); }) as unknown as typeof fetch)).kind).toBe("network");
  });
});
