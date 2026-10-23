// The real app with made-up prices. For `npm run dev:fake` and the browser tests, never the image.
import { WATCHLIST, FX_SYMBOL } from "./config.js";
import type { Bar, MarketData } from "./data/marketdata.js";
import { buildApp } from "./app.js";

const MINUTE = 60;
const DAY = 86400;
const HOURS: Record<string, [number, number]> = {
  XETRA: [7 * 3600, 15 * 3600 + 1800], // 07:00 to 15:30 UTC
  US: [13 * 3600 + 1800, 20 * 3600], // 13:30 to 20:00 UTC
};

/** A smooth, repeatable price for a symbol at a time. */
export function fakePrice(symbol: string, t: number): number {
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 997;
  const base = 40 + (h % 180);
  return base + 3 * Math.sin(t / 1800 + h) + 1.5 * Math.sin(t / 420);
}

// A present that moves: Friday 2026-10-23, 13:00 UTC at the start, then in real time. The
// bars of the test data reach exactly up to it, so a live simulation meets the edge of the present.
const FAKE_BASE = Date.UTC(2026, 9, 23, 13, 0, 0) / 1000;
const startedAt = Date.now();
export const fakeNow = () => FAKE_BASE + (Date.now() - startedAt) / 1000;

/** Minute bars Monday to Friday during each market's hours, only those that are over by `now`; the exchange rate runs all day. */
export function fakeMarketData(now: () => number = () => Date.now() / 1000): MarketData {
  const venue = new Map<string, string>(WATCHLIST.map((i) => [i.symbol, i.venue]));
  return {
    async bars(symbol, fromT, toT) {
      const bars: Bar[] = [];
      const first = Math.ceil(fromT / MINUTE) * MINUTE;
      for (let t = first; t < toT && t + MINUTE <= now(); t += MINUTE) {
        const weekday = new Date(t * 1000).getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        const secondOfDay = t % DAY;
        if (symbol !== FX_SYMBOL) {
          const hours = HOURS[venue.get(symbol) ?? ""];
          if (!hours || secondOfDay < hours[0] || secondOfDay >= hours[1]) continue;
        }
        const c = symbol === FX_SYMBOL ? 1.1 + 0.01 * Math.sin(t / 3600) : fakePrice(symbol, t);
        const o = symbol === FX_SYMBOL ? c : fakePrice(symbol, t - MINUTE);
        bars.push({ t, o, h: Math.max(o, c) + 0.1, l: Math.min(o, c) - 0.1, c, v: 100 + (t % 7) * 10 });
      }
      if (bars.length === 0) {
        const { MarketDataError } = await import("./data/marketdata.js");
        throw new MarketDataError("no_data", `fake: no trading for ${symbol} in that period`);
      }
      return bars;
    },
  };
}

export async function startFake(port: number) {
  const app = buildApp({
    dbPath: ":memory:", marketData: fakeMarketData(fakeNow), minGapMs: 0, tickMs: 100,
    now: fakeNow, catchUpTempo: 6000, liveRefreshS: 1,
  });
  await app.listen({ port, host: "127.0.0.1" });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_PORT ?? 3100);
  await startFake(port);
  console.log(`DepoSim with made-up prices on http://127.0.0.1:${port}`);
}
