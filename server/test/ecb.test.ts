import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MarketDataError } from "../src/data/marketdata.js";
import { createEcb, parseEcbCsv, parseEcbSdmx } from "../src/data/ecb.js";

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

const SDMX = [
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
  "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-23,1.1193",
  "EXR.D.JPY.EUR.SP00.A,D,JPY,EUR,SP00,A,2026-10-23,175.51",
  "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-22,1.1205",
  "",
].join("\n");

describe("parseEcbSdmx", () => {
  it("folds the long lines into one row per day, oldest first", () => {
    expect(parseEcbSdmx(SDMX)).toEqual([
      { day: "2026-10-22", rates: { USD: 1.1205 } },
      { day: "2026-10-23", rates: { USD: 1.1193, JPY: 175.51 } },
    ]);
  });

  it("skips empty values and rates of zero, and refuses what is not the answer", () => {
    expect(parseEcbSdmx(SDMX + "EXR.D.ISK.EUR.SP00.A,D,ISK,EUR,SP00,A,2026-10-23,\nEXR.D.RUB.EUR.SP00.A,D,RUB,EUR,SP00,A,2026-10-23,0\n")[1].rates).toEqual({ USD: 1.1193, JPY: 175.51 });
    for (const text of ["", "<html>no</html>", "KEY,CURRENCY,TIME_PERIOD,OBS_VALUE\n", "KEY,CURRENCY,TIME_PERIOD,OBS_VALUE\nx,USD,yesterday,1\n", "KEY,CURRENCY,TIME_PERIOD,OBS_VALUE\nx,USD,2026-10-23,abc\n"]) {
      expect(() => parseEcbSdmx(text), text).toThrow(MarketDataError);
    }
  });
});

describe("createEcb", () => {
  const answer = (status: number, body = SDMX) => (async () => new Response(body, { status })) as typeof fetch;

  it("asks the data warehouse for everything since 1999 or for the last 100 days", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => (urls.push(url), new Response(SDMX))) as unknown as typeof fetch;
    const ecb = createEcb(fetchFn);
    await ecb.fetch("full");
    await ecb.fetch("recent");
    const base = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?detail=dataonly&format=csvdata&startPeriod=";
    expect(urls[0]).toBe(base + "1999-01-01");
    expect(urls[1]).toBe(base + new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10));
  });

  it("names the kind of failure", async () => {
    const kind = async (f: typeof fetch) => (await createEcb(f).fetch("full").catch((e: MarketDataError) => e)) as MarketDataError;
    expect((await kind(answer(429))).kind).toBe("rate_limited");
    expect((await kind(answer(503))).kind).toBe("network");
    expect((await kind(answer(404))).kind).toBe("bad_shape");
    expect((await kind((async () => { throw new Error("down"); }) as unknown as typeof fetch)).kind).toBe("network");
  });
});
