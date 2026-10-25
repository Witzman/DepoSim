export type MarketEventKind = "dividend" | "split" | "gap";

export interface MarketEvent {
  /** Stable across calls, so a page can tell what it has already seen. */
  key: string;
  kind: MarketEventKind;
  symbol: string;
  /** The day, "YYYY-MM-DD" (UTC). */
  day: string;
  /** The time of the first bar of that day, where a marker sits; null when no bar of the day is known. */
  t: number | null;
  /** One line, in German. */
  text: string;
}

/** A jump from the last close to the next open of at least this share counts as a gap. */
export const GAP_THRESHOLD = 0.03;

interface Candle {
  t: number;
  o: number;
  c: number;
}

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1).replace(".", ",")} %`;

/** Bars of any length folded into one entry per UTC day: first open, last close, time of the first bar. */
export function foldDays(bars: Candle[]): { day: string; t: number; o: number; c: number }[] {
  const out: { day: string; t: number; o: number; c: number }[] = [];
  for (const b of bars) {
    const day = iso(b.t);
    const last = out[out.length - 1];
    if (last && last.day === day) last.c = b.c;
    else out.push({ day, t: b.t, o: b.o, c: b.c });
  }
  return out;
}

/** Days that opened at least `threshold` away from the close before. Pure; `bars` oldest first. */
export function findGaps(symbol: string, bars: Candle[], threshold = GAP_THRESHOLD): MarketEvent[] {
  const days = foldDays(bars);
  const out: MarketEvent[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1].c;
    if (!(prev > 0)) continue;
    const change = days[i].o / prev - 1;
    if (Math.abs(change) < threshold) continue;
    out.push({
      key: `gap:${symbol}:${days[i].day}`, kind: "gap", symbol, day: days[i].day, t: days[i].t,
      text: `Kurslücke ${symbol} ${pct(change)}: Eröffnung ${days[i].o.toFixed(2).replace(".", ",")} nach Schluss ${prev.toFixed(2).replace(".", ",")}`,
    });
  }
  return out;
}

/** Everything that happened to one title up to the last bar given, oldest first. Nothing after that bar. */
export function marketEvents(input: {
  symbol: string;
  currency: "EUR" | "USD";
  bars: Candle[];
  dividends: { exDay: string; amount: number }[];
  splits: { day: string; numerator: number; denominator: number }[];
  threshold?: number;
}): MarketEvent[] {
  const days = foldDays(input.bars);
  const last = days[days.length - 1]?.day;
  if (last === undefined) return [];
  const timeOf = (day: string) => days.find((d) => d.day === day)?.t ?? null;
  const out: MarketEvent[] = [...findGaps(input.symbol, input.bars, input.threshold)];
  for (const d of input.dividends) {
    if (d.exDay > last) continue;
    out.push({
      key: `dividend:${input.symbol}:${d.exDay}`, kind: "dividend", symbol: input.symbol, day: d.exDay, t: timeOf(d.exDay),
      text: `Ausschüttung ${input.symbol} ${d.amount.toFixed(2).replace(".", ",")} ${input.currency === "USD" ? "$" : "€"} je Stück (Ex-Tag)`,
    });
  }
  for (const s of input.splits) {
    if (s.day > last) continue;
    out.push({
      key: `split:${input.symbol}:${s.day}`, kind: "split", symbol: input.symbol, day: s.day, t: timeOf(s.day),
      text: `Aktiensplit ${input.symbol} ${s.numerator}:${s.denominator}`,
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind));
}
