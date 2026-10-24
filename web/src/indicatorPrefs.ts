import { INDICATOR_IDS, type IndicatorConfig, type IndicatorId } from "./indicators.js";

export const INDICATORS_KEY = "deposim-indicators";

export interface IndicatorParams {
  sma: { period: number };
  ema: { period: number };
  rsi: { period: number };
  macd: { fast: number; slow: number; signal: number };
  bollinger: { period: number; k: number };
}

export interface IndicatorPrefs { enabled: IndicatorId[]; params: IndicatorParams }

export const defaultParams = (): IndicatorParams => ({
  sma: { period: 20 }, ema: { period: 20 }, rsi: { period: 14 },
  macd: { fast: 12, slow: 26, signal: 9 }, bollinger: { period: 20, k: 2 },
});

export const defaultPrefs = (): IndicatorPrefs => ({ enabled: [], params: defaultParams() });

const num = (v: unknown, fallback: number, integer: boolean) =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 500 && (!integer || Number.isInteger(v)) ? v : fallback;

/** Never throws; anything unusable falls back to the defaults. */
export function parsePrefs(raw: string | null): IndicatorPrefs {
  const out = defaultPrefs();
  if (!raw) return out;
  try {
    const o = JSON.parse(raw);
    if (Array.isArray(o?.enabled)) {
      out.enabled = INDICATOR_IDS.filter((id) => o.enabled.includes(id));
    }
    const d = defaultParams();
    const p = o?.params ?? {};
    out.params = {
      sma: { period: num(p.sma?.period, d.sma.period, true) },
      ema: { period: num(p.ema?.period, d.ema.period, true) },
      rsi: { period: num(p.rsi?.period, d.rsi.period, true) },
      macd: {
        fast: num(p.macd?.fast, d.macd.fast, true), slow: num(p.macd?.slow, d.macd.slow, true),
        signal: num(p.macd?.signal, d.macd.signal, true),
      },
      bollinger: { period: num(p.bollinger?.period, d.bollinger.period, true), k: num(p.bollinger?.k, d.bollinger.k, false) },
    };
  } catch {
    return defaultPrefs();
  }
  return out;
}

export function loadPrefs(): IndicatorPrefs {
  try {
    return parsePrefs(localStorage.getItem(INDICATORS_KEY));
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(p: IndicatorPrefs) {
  try {
    localStorage.setItem(INDICATORS_KEY, JSON.stringify(p));
  } catch { /* blocked storage: the choice just is not remembered */ }
}

export function toConfig(p: IndicatorPrefs): IndicatorConfig {
  const c: IndicatorConfig = {};
  for (const id of p.enabled) (c as Record<string, unknown>)[id] = p.params[id];
  return c;
}
