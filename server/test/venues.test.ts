import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { VENUES } from "../src/config.js";
import { venueOpenAt } from "../src/domain/venues.js";
import { AAPL, D0, H, SAP, makeSource } from "./fakes.js";

const venue = (id: string) => VENUES.find((v) => v.id === id)!;

describe("VENUES", () => {
  it("lists the two real markets with a source and the others without", () => {
    expect(VENUES.map((v) => [v.id, v.hasSource])).toEqual([
      ["XETRA", true], ["US", true], ["FRANKFURT", false], ["TRADEGATE", false], ["GETTEX", false],
    ]);
    for (const v of VENUES) expect(v.name).toBeTruthy();
  });
});

describe("venueOpenAt", () => {
  // D0 is Thursday 2026-10-22, still summer time in Berlin (UTC+2) and New York (UTC-4).
  it("follows the local hours, summer time included", () => {
    expect(venueOpenAt(venue("XETRA"), D0 + 6 * H + 59 * 60)).toBe(false); // 08:59 Berlin
    expect(venueOpenAt(venue("XETRA"), D0 + 7 * H)).toBe(true); // 09:00 Berlin
    expect(venueOpenAt(venue("XETRA"), D0 + 15 * H + 29 * 60)).toBe(true);
    expect(venueOpenAt(venue("XETRA"), D0 + 15 * H + 30 * 60)).toBe(false); // 17:30 Berlin
    expect(venueOpenAt(venue("US"), D0 + 13 * H + 29 * 60)).toBe(false);
    expect(venueOpenAt(venue("US"), D0 + 13 * H + 30 * 60)).toBe(true); // 09:30 New York
    expect(venueOpenAt(venue("US"), D0 + 20 * H)).toBe(false); // 16:00 New York
  });

  it("is closed on a weekend", () => {
    const saturday = D0 + 2 * 86400;
    expect(venueOpenAt(venue("XETRA"), saturday + 10 * H)).toBe(false);
    expect(venueOpenAt(venue("US"), saturday + 15 * H)).toBe(false);
  });
});

describe("venues in the API", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });
  const make = () => {
    const app = buildApp({ dbPath: ":memory:", marketData: makeSource().source, instruments: [SAP, AAPL], now: () => D0, minGapMs: 0 });
    apps.push(app);
    return app;
  };

  it("lists every market with its hours and whether it has a source", async () => {
    const list = (await make().inject({ url: "/api/venues" })).json();
    expect(list.map((v: any) => v.id)).toEqual(["XETRA", "US", "FRANKFURT", "TRADEGATE", "GETTEX"]);
    expect(list[0]).toMatchObject({ name: "Xetra", opens: "09:00", closes: "17:30", hasSource: true });
    expect(list[3]).toMatchObject({ hasSource: false });
  });

  it.each(["SAP.F", "sap.f", "SAP.TG", "SAP.GETTEX"])("refuses to add %s, a market without a source", async (symbol) => {
    const res = await make().inject({ method: "POST", url: "/api/watchlist", payload: { symbol } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/keine Kursquelle/);
  });
});
