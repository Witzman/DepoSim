import type { Bar } from "./types.js";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "1d";
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "1d"];
export const TIMEFRAME_LABEL: Record<Timeframe, string> = { "1m": "1 Min", "5m": "5 Min", "15m": "15 Min", "1h": "1 Std", "1d": "Tag" };

const SECONDS: Record<Exclude<Timeframe, "1d">, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };
const berlinDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });

/** How many one-minute bars to ask for so the chart still shows a useful stretch at this timeframe. */
export const RAW_LIMIT: Record<Timeframe, number> = { "1m": 500, "5m": 2500, "15m": 6000, "1h": 12000, "1d": 20000 };

/** The start of the candle a bar belongs to. Days are Berlin days; the other steps align to the UTC clock. */
function bucketOf(t: number, tf: Timeframe): number | string {
  return tf === "1d" ? berlinDay.format(t * 1000) : Math.floor(t / SECONDS[tf]) * SECONDS[tf];
}

/**
 * Candles of a coarser timeframe from finer bars in time order. A candle is stamped with the time of its
 * first bar, so a candle still forming at the right edge keeps its time while it grows.
 */
export function aggregate(bars: Bar[], tf: Timeframe): Bar[] {
  if (tf === "1m") return bars;
  const out: Bar[] = [];
  let key: number | string | null = null;
  for (const b of bars) {
    const k = bucketOf(b.t, tf);
    const last = out[out.length - 1];
    if (last && k === key) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else {
      out.push({ ...b });
      key = k;
    }
  }
  return out;
}

/** Heikin-Ashi candles: smoothed, the close is the bar's mean, the open the middle of the last candle's body. */
export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const c = (b.o + b.h + b.l + b.c) / 4;
    const prev = out[out.length - 1];
    const o = prev ? (prev.o + prev.c) / 2 : (b.o + b.c) / 2;
    out.push({ t: b.t, o, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), c, v: b.v });
  }
  return out;
}

export type ChartType = "candles" | "heikin" | "line";
export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: "candles", label: "Kerzen" }, { id: "heikin", label: "Heikin-Ashi" }, { id: "line", label: "Linie" },
];
export type ScaleMode = "normal" | "log" | "percent";
export const SCALE_MODES: { id: ScaleMode; label: string }[] = [
  { id: "normal", label: "Linear" }, { id: "log", label: "Log" }, { id: "percent", label: "%" },
];

export interface ChartPrefs { timeframe: Timeframe; type: ChartType; scale: ScaleMode }
export const CHART_PREFS_KEY = "deposim-chart";
export const defaultChartPrefs = (): ChartPrefs => ({ timeframe: "1m", type: "candles", scale: "normal" });

/** Never throws; anything unusable falls back to the defaults. */
export function parseChartPrefs(raw: string | null): ChartPrefs {
  const out = defaultChartPrefs();
  if (!raw) return out;
  try {
    const o = JSON.parse(raw);
    if (TIMEFRAMES.includes(o?.timeframe)) out.timeframe = o.timeframe;
    if (CHART_TYPES.some((t) => t.id === o?.type)) out.type = o.type;
    if (SCALE_MODES.some((m) => m.id === o?.scale)) out.scale = o.scale;
  } catch { /* defaults */ }
  return out;
}

/** The change of a bar against the one before it: absolute and as a ratio, or null for the first bar. */
export function barChange(bars: Bar[], index: number): { abs: number; ratio: number } | null {
  if (index < 1 || index >= bars.length || bars[index - 1].c === 0) return null;
  const abs = bars[index].c - bars[index - 1].c;
  return { abs, ratio: abs / bars[index - 1].c };
}
