import type { VenueInfo } from "../config.js";

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Weekday and minutes since local midnight at UTC second `t`, in the zone. */
function localTime(timeZone: string, t: number): { weekday: string; minutes: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Whether the market's regular hours cover UTC second `t`. Holidays are not known, so a holiday
 * counts as open; the caller treats "open" as the cautious answer.
 */
export function venueOpenAt(venue: VenueInfo, t: number): boolean {
  const { weekday, minutes } = localTime(venue.timeZone, t);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return minutes >= minutesOf(venue.opens) && minutes < minutesOf(venue.closes);
}
