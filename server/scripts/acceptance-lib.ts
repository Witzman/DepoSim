import { lastTradingDay } from "../../web/src/time.js";

/**
 * The last weekday before today in Berlin, as "YYYY-MM-DD". Each `tryBack` goes one more
 * trading day back, for the day a holiday left without prices.
 */
export function lastTradingDayBefore(today: Date, tryBack = 0): string {
  let day = lastTradingDay(today);
  for (let i = 0; i < tryBack; i++) {
    const [y, m, d] = day.split("-").map(Number);
    day = lastTradingDay(new Date(Date.UTC(y, m - 1, d, 12)));
  }
  return day;
}
