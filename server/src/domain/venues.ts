import type { VenueInfo } from "../config.js";
import { earlyClose, holidayName } from "./calendar.js";

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Local date "YYYY-MM-DD", weekday and minutes since local midnight at UTC second `t`, in the zone. */
export function localTime(timeZone: string, t: number): { day: string; weekday: string; minutes: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map((p) => [p.type, p.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** What one local day looks like on a market. */
export interface Session {
  trading: boolean;
  /** Local "HH:MM" of the day; `closes` is earlier than the regular time on a short day. */
  opens: string;
  closes: string;
  early: boolean;
  /** German reason, only when `trading` is false: "Wochenende" or "Feiertag: Karfreitag". */
  reason?: string;
}

/** The session of a local ISO day ("YYYY-MM-DD") on the market, with weekends, holidays and short days. */
export function sessionFor(venue: VenueInfo, day: string): Session {
  const base = { opens: venue.opens, closes: venue.closes, early: false };
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return { ...base, trading: false, reason: "Wochenende" };
  if (venue.calendar) {
    const holiday = holidayName(venue.calendar, day);
    if (holiday) return { ...base, trading: false, reason: `Feiertag: ${holiday}` };
    const closes = earlyClose(venue.calendar, day);
    if (closes) return { ...base, trading: true, closes, early: true };
  }
  return { ...base, trading: true };
}

/** Whether the market's hours of that day cover UTC second `t`: weekends, holidays and short days included. */
export function venueOpenAt(venue: VenueInfo, t: number): boolean {
  const { day, minutes } = localTime(venue.timeZone, t);
  const session = sessionFor(venue, day);
  if (!session.trading) return false;
  return minutes >= minutesOf(session.opens) && minutes < minutesOf(session.closes);
}

/** The reason the market is shut for the whole local day at UTC second `t` (weekend or holiday), or undefined. */
export function closedDayReason(venue: VenueInfo, t: number): string | undefined {
  return sessionFor(venue, localTime(venue.timeZone, t).day).reason;
}
