const TZ = "Europe/Berlin";

const wall = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const display = new Intl.DateTimeFormat("de-DE", {
  timeZone: TZ, hourCycle: "h23", day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function berlinParts(ms: number) {
  const p: Record<string, number> = {};
  for (const part of wall.formatToParts(ms)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** "2026-10-23" and "10:00" as Berlin wall-clock time, in UTC seconds. */
export function berlinToUtcSeconds(date: string, time: string): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) throw new Error("Bitte Datum und Uhrzeit angeben.");
  const [y, mo, day, hh, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  const naive = Date.UTC(y, mo - 1, day, hh, mi);
  const check = new Date(naive);
  if (hh > 23 || mi > 59 || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day) {
    throw new Error("Datum oder Uhrzeit gibt es nicht.");
  }
  // Berlin is UTC+2 in summer and UTC+1 in winter. Try summer first: when a wall time happens
  // twice (the autumn change) that picks the first one. A wall time that never happens
  // (the spring change) matches neither and falls back to the winter offset, which lands on
  // the same instant as one hour later on the clock.
  for (const offsetH of [2, 1]) {
    const candidate = naive - offsetH * 3600_000;
    const p = berlinParts(candidate);
    if (p.year === y && p.month === mo && p.day === day && p.hour === hh && p.minute === mi) return candidate / 1000;
  }
  return (naive - 3600_000) / 1000;
}

const dayDisplay = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });

/** "23.10.2026, 10:00:00", Berlin time; for a daily simulation "23.10.2026", the day that is played next. */
export function formatSimTime(utcSeconds: number, daily = false): string {
  // A daily simulation has no time of day: the clock stands at the midnight between two trading days.
  return daily ? dayDisplay.format(utcSeconds * 1000) : display.format(utcSeconds * 1000);
}

/** The last weekday before today in Berlin, as "YYYY-MM-DD". Holidays are not known here. */
export function lastTradingDay(today: Date): string {
  const p = berlinParts(today.getTime());
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const weekday = date.getUTCDay(); // 0 Sunday .. 6 Saturday
  const back = weekday === 1 ? 3 : weekday === 0 ? 2 : 1;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}
