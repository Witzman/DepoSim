// Manual check, not part of the tests: asks the real Yahoo endpoint for the last
// three days of minute bars of every watchlist instrument and the exchange rate.
import { FX_SYMBOL, WATCHLIST } from "../src/config.js";
import { MarketDataError } from "../src/data/marketdata.js";
import { createYahoo } from "../src/data/yahoo.js";

const source = createYahoo();
const now = Math.floor(Date.now() / 1000);
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16) + "Z";

console.log(`period ${iso(now - 3 * 86400)} .. ${iso(now)}`);
let limited = 0;
for (const symbol of [...WATCHLIST.map((i) => i.symbol), FX_SYMBOL]) {
  try {
    const bars = await source.bars(symbol, now - 3 * 86400, now);
    const days = new Set(bars.map((b) => new Date(b.t * 1000).toISOString().slice(0, 10)));
    console.log(
      `${symbol.padEnd(9)} bars=${String(bars.length).padStart(4)} days=${days.size} ` +
        `first=${bars.length ? iso(bars[0].t) : "-"} last=${bars.length ? iso(bars[bars.length - 1].t) : "-"}`,
    );
  } catch (err) {
    const kind = err instanceof MarketDataError ? err.kind : "error";
    if (kind === "rate_limited") limited++;
    console.log(`${symbol.padEnd(9)} FAILED ${kind}: ${(err as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`rate limited: ${limited}`);
