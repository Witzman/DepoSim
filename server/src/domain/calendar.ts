/**
 * Trading calendars of the two markets with a price source, computed from rules (Easter, "fourth
 * Thursday", "observed on the Friday") instead of a hand-kept list. Days are local ISO dates
 * "YYYY-MM-DD" of the market. Pure functions, no clock.
 *
 * Not covered: auctions and opening phases, days closed by a disruption, other markets.
 * Checked against the real trading days 2019 to 2026 in test/calendar.test.ts.
 */

export type CalendarId = "XETRA" | "NYSE";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
/** Midnight UTC of an ISO date; only used for calendar arithmetic, so the zone does not matter. */
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
const isoOf = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = asDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
}

/** 0 = Sunday ... 6 = Saturday. */
export const weekdayOf = (day: string) => asDate(day).getUTCDay();

/** Easter Sunday of a year (Gauss's rule, Gregorian calendar). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** The n-th `weekday` (0 = Sunday) of a month, or the last one for n = -1. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = weekdayOf(iso(year, month, 1));
    return iso(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekdayOf(iso(year, month, lastDay));
  return iso(year, month, lastDay - ((last - weekday + 7) % 7));
}

/** A fixed date that a weekend moves: Saturday to the Friday before, Sunday to the Monday after. */
function observed(year: number, month: number, day: number): string {
  const d = iso(year, month, day);
  const w = weekdayOf(d);
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, 1) : d;
}

type Table = Map<string, string>;
const tables = new Map<string, Table>();

function xetraHolidays(year: number): Table {
  const easter = easterSunday(year);
  return new Map([
    [iso(year, 1, 1), "Neujahr"],
    [addDays(easter, -2), "Karfreitag"],
    [addDays(easter, 1), "Ostermontag"],
    [iso(year, 5, 1), "Tag der Arbeit"],
    [iso(year, 12, 24), "Heiligabend"],
    [iso(year, 12, 25), "1. Weihnachtstag"],
    [iso(year, 12, 26), "2. Weihnachtstag"],
    [iso(year, 12, 31), "Silvester"],
  ]);
}

/** One-off closures that are no rule. Few, and each one is a fact about a single day. */
const NYSE_SPECIAL: Record<string, string> = {
  "2025-01-09": "Staatstrauertag (Carter)",
};

function nyseHolidays(year: number): Table {
  const t: Table = new Map();
  // New Year on a Saturday is not moved to the Friday: the year-end books stay open.
  if (weekdayOf(iso(year, 1, 1)) !== 6) t.set(observed(year, 1, 1), "Neujahr");
  t.set(nthWeekday(year, 1, 1, 3), "Martin Luther King Day");
  t.set(nthWeekday(year, 2, 1, 3), "Presidents Day");
  t.set(addDays(easterSunday(year), -2), "Karfreitag");
  t.set(nthWeekday(year, 5, 1, -1), "Memorial Day");
  if (year >= 2022) t.set(observed(year, 6, 19), "Juneteenth");
  t.set(observed(year, 7, 4), "Unabhängigkeitstag");
  t.set(nthWeekday(year, 9, 1, 1), "Labor Day");
  t.set(nthWeekday(year, 11, 4, 4), "Thanksgiving");
  t.set(observed(year, 12, 25), "Weihnachten");
  for (const [day, name] of Object.entries(NYSE_SPECIAL)) if (day.startsWith(`${year}-`)) t.set(day, name);
  return t;
}

function table(cal: CalendarId, year: number): Table {
  const key = `${cal}:${year}`;
  let t = tables.get(key);
  if (!t) {
    t = cal === "XETRA" ? xetraHolidays(year) : nyseHolidays(year);
    tables.set(key, t);
  }
  return t;
}

/** The German name of the holiday on which the market is closed, or undefined on any other day. */
export function holidayName(cal: CalendarId, day: string): string | undefined {
  return table(cal, Number(day.slice(0, 4))).get(day);
}

/** Local "HH:MM" at which a shortened trading day ends, or undefined for a normal or a closed day. */
export function earlyClose(cal: CalendarId, day: string): string | undefined {
  if (cal !== "NYSE") return undefined;
  const w = weekdayOf(day);
  if (w === 0 || w === 6 || holidayName(cal, day)) return undefined;
  const year = Number(day.slice(0, 4));
  if (day === addDays(nthWeekday(year, 11, 4, 4), 1)) return "13:00"; // day after Thanksgiving
  if (day === iso(year, 12, 24)) return "13:00"; // Christmas Eve
  // 3 July, when 4 July is a Tuesday to Friday (otherwise 3 July is a weekend or the observed holiday).
  if (day === iso(year, 7, 3) && weekdayOf(iso(year, 7, 4)) >= 2 && weekdayOf(iso(year, 7, 4)) <= 5) return "13:00";
  return undefined;
}
