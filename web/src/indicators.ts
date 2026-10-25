import { berlinDay } from "./bars.js";

// Technical indicators as pure functions. Every result has the input's length;
// entries are null until the indicator is defined. Never NaN.
export type Series = (number | null)[];

const nulls = (n: number): Series => Array<number | null>(n).fill(null);
const valid = (period: number) => Number.isInteger(period) && period >= 1;

export function sma(values: number[], period: number): Series {
  const out = nulls(values.length);
  if (!valid(period) || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA over a series that may start with nulls; seeded with the SMA of the first `period` defined values. */
function emaOf(values: Series, period: number): Series {
  const out = nulls(values.length);
  if (!valid(period)) return out;
  const first = values.findIndex((v) => v !== null);
  if (first < 0 || values.length - first < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = first; i < first + period; i++) seed += values[i]!;
  let prev = seed / period;
  out[first + period - 1] = prev;
  for (let i = first + period; i < values.length; i++) {
    prev = prev + k * (values[i]! - prev);
    out[i] = prev;
  }
  return out;
}

export const ema = (values: number[], period: number): Series => emaOf(values, period);

export function rsi(values: number[], period = 14): Series {
  const out = nulls(values.length);
  if (!valid(period) || values.length <= period) return out;
  const value = (gain: number, loss: number) =>
    gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = value(gain, loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value(gain, loss);
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9) {
  const f = emaOf(values, fast);
  const s = emaOf(values, slow);
  const line = values.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  const signal = emaOf(line, signalPeriod);
  const hist = line.map((m, i) => (m !== null && signal[i] !== null ? m - signal[i]! : null));
  return { macd: line, signal, hist };
}

export function bollinger(values: number[], period = 20, k = 2) {
  const mid = sma(values, period);
  const upper = nulls(values.length);
  const lower = nulls(values.length);
  for (let i = 0; i < values.length; i++) {
    const m = mid[i];
    if (m === null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - m) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}

/** Mean of the last `period` values of a series that may start with nulls; null while a null is inside the window. */
function smaOf(values: Series, period: number): Series {
  const out = nulls(values.length);
  if (!valid(period)) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null) { ok = false; break; }
      sum += v;
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}

/** Average true range, Wilder smoothing: seeded with the mean of the first `period` true ranges. */
export function atr(bars: Ohlcv[], period = 14): Series {
  const out = nulls(bars.length);
  if (!valid(period) || bars.length <= period) return out;
  const tr = (i: number) => Math.max(
    bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c),
  );
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr(i);
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr(i)) / period;
    out[i] = prev;
  }
  return out;
}

/** Stochastic oscillator: %K over `k` bars (50 when the range is flat), %D its mean over `d` bars. */
export function stochastic(bars: Ohlcv[], k = 14, d = 3) {
  const line = nulls(bars.length);
  if (valid(k)) {
    for (let i = k - 1; i < bars.length; i++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - k + 1; j <= i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
      line[i] = hi - lo === 0 ? 50 : ((bars[i].c - lo) / (hi - lo)) * 100;
    }
  }
  return { k: line, d: smaOf(line, d) };
}

/** On-balance volume: volume added on a higher close, subtracted on a lower one. Starts at 0. */
export function obv(bars: Ohlcv[]): Series {
  const out = nulls(bars.length);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) sum += bars[i].c > bars[i - 1].c ? bars[i].v : bars[i].c < bars[i - 1].c ? -bars[i].v : 0;
    out[i] = sum;
  }
  return out;
}


/** Volume-weighted average price of the typical price (high+low+close)/3, restarting every Berlin day. */
export function vwap(bars: Ohlcv[]): Series {
  const out = nulls(bars.length);
  let day = "";
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = berlinDay(bars[i].t);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    pv += ((bars[i].h + bars[i].l + bars[i].c) / 3) * bars[i].v;
    vol += bars[i].v;
    if (vol > 0) out[i] = pv / vol;
  }
  return out;
}

/** The part of a bar the volume-based indicators need. */
export type Ohlcv = { t: number; o: number; h: number; l: number; c: number; v: number };

export type IndicatorId = "sma" | "ema" | "rsi" | "macd" | "bollinger" | "vwap" | "atr" | "stoch" | "obv";
export const INDICATOR_IDS: IndicatorId[] = ["sma", "ema", "bollinger", "vwap", "rsi", "macd", "stoch", "atr", "obv"];

/** An indicator is enabled when its entry is present. */
export interface IndicatorConfig {
  sma?: { period: number };
  ema?: { period: number };
  rsi?: { period: number };
  macd?: { fast: number; slow: number; signal: number };
  bollinger?: { period: number; k: number };
  vwap?: Record<string, never>;
  atr?: { period: number };
  stoch?: { k: number; d: number };
  obv?: Record<string, never>;
}

export interface IndicatorResult {
  sma?: Series;
  ema?: Series;
  rsi?: Series;
  macd?: ReturnType<typeof macd>;
  bollinger?: ReturnType<typeof bollinger>;
  vwap?: Series;
  atr?: Series;
  stoch?: ReturnType<typeof stochastic>;
  obv?: Series;
}

/** `bars` (same length as `closes`) is needed for VWAP, ATR, Stochastic and OBV; without it those stay out. */
export function compute(closes: number[], enabled: IndicatorConfig, bars?: Ohlcv[]): IndicatorResult {
  const r: IndicatorResult = {};
  if (enabled.sma) r.sma = sma(closes, enabled.sma.period);
  if (enabled.ema) r.ema = ema(closes, enabled.ema.period);
  if (enabled.rsi) r.rsi = rsi(closes, enabled.rsi.period);
  if (enabled.macd) r.macd = macd(closes, enabled.macd.fast, enabled.macd.slow, enabled.macd.signal);
  if (enabled.bollinger) r.bollinger = bollinger(closes, enabled.bollinger.period, enabled.bollinger.k);
  if (bars && bars.length === closes.length) {
    if (enabled.vwap) r.vwap = vwap(bars);
    if (enabled.atr) r.atr = atr(bars, enabled.atr.period);
    if (enabled.stoch) r.stoch = stochastic(bars, enabled.stoch.k, enabled.stoch.d);
    if (enabled.obv) r.obv = obv(bars);
  }
  return r;
}
