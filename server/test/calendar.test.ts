import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VENUES } from "../src/config.js";
import { earlyClose, easterSunday, holidayName, nthWeekday } from "../src/domain/calendar.js";
import { sessionFor, venueOpenAt } from "../src/domain/venues.js";
import { H } from "./fakes.js";

const venue = (id: string) => VENUES.find((v) => v.id === id)!;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

describe("easterSunday", () => {
  it.each([
    [2019, "2019-04-21"], [2020, "2020-04-12"], [2021, "2021-04-04"], [2022, "2022-04-17"],
    [2023, "2023-04-09"], [2024, "2024-03-31"], [2025, "2025-04-20"], [2026, "2026-04-05"], [2027, "2027-03-28"],
  ])("%i", (year, iso) => expect(easterSunday(year)).toBe(iso));
});

describe("nthWeekday", () => {
  it("finds the n-th and the last weekday of a month", () => {
    expect(nthWeekday(2025, 11, 4, 4)).toBe("2025-11-27"); // Thanksgiving
    expect(nthWeekday(2026, 11, 4, 4)).toBe("2026-11-26");
    expect(nthWeekday(2025, 5, 1, -1)).toBe("2025-05-26"); // Memorial Day
    expect(nthWeekday(2024, 9, 1, 1)).toBe("2024-09-02"); // Labor Day
  });
});

describe("holidayName", () => {
  it("names the Xetra holidays, Karfreitag and Silvester among them", () => {
    expect(holidayName("XETRA", "2026-04-03")).toBe("Karfreitag");
    expect(holidayName("XETRA", "2026-04-06")).toBe("Ostermontag");
    expect(holidayName("XETRA", "2025-12-24")).toBe("Heiligabend");
    expect(holidayName("XETRA", "2025-12-31")).toBe("Silvester");
    expect(holidayName("XETRA", "2025-05-01")).toBe("Tag der Arbeit");
    expect(holidayName("XETRA", "2025-06-09")).toBeUndefined(); // Pfingstmontag: Xetra trades
    expect(holidayName("XETRA", "2025-10-03")).toBeUndefined(); // Tag der Deutschen Einheit: trades
  });

  it("names the US holidays and moves the ones that fall on a weekend", () => {
    expect(holidayName("NYSE", "2025-11-27")).toBe("Thanksgiving");
    expect(holidayName("NYSE", "2025-01-20")).toBe("Martin Luther King Day");
    expect(holidayName("NYSE", "2025-06-19")).toBe("Juneteenth");
    expect(holidayName("NYSE", "2021-06-19")).toBeUndefined(); // not yet a market holiday
    expect(holidayName("NYSE", "2026-07-03")).toBe("Unabhängigkeitstag"); // 4 July is a Saturday: Friday off
    expect(holidayName("NYSE", "2021-12-24")).toBe("Weihnachten"); // 25 December is a Saturday
    expect(holidayName("NYSE", "2022-12-26")).toBe("Weihnachten"); // a Sunday: Monday off
    expect(holidayName("NYSE", "2021-12-31")).toBeUndefined(); // New Year on a Saturday: no Friday off
    expect(holidayName("NYSE", "2023-01-02")).toBe("Neujahr"); // Sunday: Monday off
    expect(holidayName("NYSE", "2025-01-09")).toBe("Staatstrauertag (Carter)");
  });
});

describe("earlyClose", () => {
  it("shortens the US day after Thanksgiving, Christmas Eve and 3 July", () => {
    expect(earlyClose("NYSE", "2025-11-28")).toBe("13:00");
    expect(earlyClose("NYSE", "2025-12-24")).toBe("13:00");
    expect(earlyClose("NYSE", "2024-07-03")).toBe("13:00");
    expect(earlyClose("NYSE", "2026-07-03")).toBeUndefined(); // closed altogether
    expect(earlyClose("NYSE", "2021-12-24")).toBeUndefined(); // closed altogether
    expect(earlyClose("NYSE", "2025-11-26")).toBeUndefined();
  });
  it("knows no short day for Xetra", () => expect(earlyClose("XETRA", "2025-12-23")).toBeUndefined());
});

describe("sessionFor", () => {
  it("says why a day is closed", () => {
    expect(sessionFor(venue("XETRA"), "2026-04-03")).toMatchObject({ trading: false, reason: "Feiertag: Karfreitag" });
    expect(sessionFor(venue("XETRA"), "2026-04-04")).toMatchObject({ trading: false, reason: "Wochenende" });
    expect(sessionFor(venue("XETRA"), "2026-04-07")).toMatchObject({ trading: true, opens: "09:00", closes: "17:30", early: false });
  });
  it("shortens the US day after Thanksgiving to 13:00", () => {
    expect(sessionFor(venue("US"), "2025-11-28")).toMatchObject({ trading: true, opens: "09:30", closes: "13:00", early: true });
  });
  it("leaves a market without a calendar as it was", () => {
    expect(sessionFor(venue("TRADEGATE"), "2026-04-03")).toMatchObject({ trading: true, closes: "22:00" });
  });
});

describe("venueOpenAt with the calendar", () => {
  it("is closed on a holiday during regular hours", () => {
    expect(venueOpenAt(venue("XETRA"), utc("2026-04-03") + 9 * H)).toBe(false); // Karfreitag 11:00 Berlin
    expect(venueOpenAt(venue("XETRA"), utc("2026-04-02") + 9 * H)).toBe(true);
    expect(venueOpenAt(venue("US"), utc("2025-11-27") + 16 * H)).toBe(false); // Thanksgiving
  });
  it("ends the US day at 13:00 New York time after Thanksgiving", () => {
    // 2025-11-28: New York is UTC-5, 13:00 local is 18:00 UTC.
    expect(venueOpenAt(venue("US"), utc("2025-11-28") + 17 * H + 59 * 60)).toBe(true);
    expect(venueOpenAt(venue("US"), utc("2025-11-28") + 18 * H)).toBe(false);
    expect(venueOpenAt(venue("US"), utc("2025-11-26") + 18 * H)).toBe(true); // a normal day
  });
  it("takes the local date, not the UTC date, across the zone change", () => {
    // 2026-11-02 is after the US switch back (1 Nov) and before Berlin... Berlin switched on 25 Oct.
    expect(venueOpenAt(venue("US"), utc("2026-11-02") + 14 * H + 30 * 60)).toBe(true); // 09:30 EST
    expect(venueOpenAt(venue("US"), utc("2026-11-02") + 14 * H + 29 * 60)).toBe(false);
    // 23:30 New York on Thanksgiving is already 04:30 UTC the next day, a Friday: still the holiday's own day.
    expect(venueOpenAt(venue("US"), utc("2025-11-28") + 4 * H + 30 * 60)).toBe(false);
  });
});

/** Trading days measured from Yahoo's daily bars (SAP.DE and AAPL), see the fixture. */
const measured = JSON.parse(readFileSync(new URL("./fixtures/daily-trading-days.json", import.meta.url), "utf8")) as {
  from: string; to: string; XETRA: { days: string[] }; US: { days: string[] };
};

/**
 * Days where the calendar says "open" and Yahoo's daily series has no bar. All four are German public
 * holidays on which Xetra traded according to its published trading calendar (closed only on New Year,
 * Good Friday, Easter Monday, 1 May, 24/25/26/31 December); Yahoo's series simply skips them from 2019 to 2021 and
 * has bars for Whit Monday from 2022 on. Kept as a list so a new disagreement still fails.
 */
const YAHOO_GAPS: Record<string, string[]> = {
  XETRA: ["2019-06-10", "2019-10-03", "2020-06-01", "2021-05-24"],
  US: [],
};

describe.each([["XETRA", "SAP.DE"], ["US", "AAPL"]] as const)("calendar against the measured days: %s (%s)", (id) => {
  const traded = new Set(measured[id].days);
  const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
  it.each(years)("%i: the weekdays without a bar are exactly the calendar's closed days", (year) => {
    const wrong: string[] = [];
    for (let t = utc(`${year}-01-01`); t < utc(`${year + 1}-01-01`); t += 86400) {
      const day = new Date(t * 1000).toISOString().slice(0, 10);
      if (day < measured.from || day > measured.to) continue;
      if (YAHOO_GAPS[id].includes(day)) {
        expect(sessionFor(venue(id), day).trading).toBe(true);
        continue;
      }
      const s = sessionFor(venue(id), day);
      if (s.trading !== traded.has(day)) wrong.push(`${day} calendar ${s.reason ?? "open"}, measured ${traded.has(day) ? "traded" : "no bar"}`);
    }
    expect(wrong).toEqual([]);
  });
});
