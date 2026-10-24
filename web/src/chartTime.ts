// Chart times are UTC seconds; the axes show Berlin time.
const berlinTime = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
});
const berlinDay = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit" });
const berlinFull = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin", hourCycle: "h23", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});

export const tickMarkFormatter = (time: number, type: number) =>
  type >= 3 ? berlinTime.format(time * 1000) : berlinDay.format(time * 1000);
export const timeFormatter = (time: number) => berlinFull.format(time * 1000);
