import {
  CandlestickSeries, ColorType, HistogramSeries, LineSeries, LineStyle, createChart,
  type IChartApi, type ISeriesApi, type SeriesType, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { tickMarkFormatter, timeFormatter } from "../chartTime.js";
import { loadPrefs, savePrefs, toConfig, type IndicatorPrefs } from "../indicatorPrefs.js";
import type { Series } from "../indicators.js";
import { useIndicators } from "../useIndicators.js";
import { IndicatorMenu } from "./IndicatorMenu.js";
import type { Theme } from "../theme.js";
import type { Bar } from "../types.js";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function colors() {
  return { text: css("--muted"), grid: css("--border"), surface: css("--surface"), up: css("--up"), down: css("--down") };
}

const candle = (b: Bar) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c });
const volume = (b: Bar) => ({
  time: b.t as UTCTimestamp, value: b.v, color: (b.c >= b.o ? css("--up") : css("--down")) + "66",
});

interface Props {
  bars: Bar[];
  theme: Theme;
}

const points = (bars: Bar[], values: Series) => {
  const out: { time: UTCTimestamp; value: number }[] = [];
  values.forEach((v, i) => { if (v !== null && Number.isFinite(v)) out.push({ time: bars[i].t as UTCTimestamp, value: v }); });
  return out;
};

/**
 * Candles with volume, optional indicators. New bars at the end are added one at a time; anything else
 * (another symbol, another simulation) replaces the data.
 */
export function Chart({ bars, theme }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumes = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastT = useRef<number | null>(null);
  const indicatorSeries = useRef<ISeriesApi<SeriesType>[]>([]);
  const [prefs, setPrefs] = useState<IndicatorPrefs>(loadPrefs);
  const [panes, setPanes] = useState(1);
  const config = useMemo(() => toConfig(prefs), [prefs]);
  const closes = useMemo(() => bars.map((b) => b.c), [bars]);
  const { result } = useIndicators(closes, config);

  const changePrefs = (p: IndicatorPrefs) => { setPrefs(p); savePrefs(p); };

  useEffect(() => {
    const c = colors();
    const api = createChart(host.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.grid },
      timeScale: {
        borderColor: c.grid, timeVisible: true, secondsVisible: false,
        tickMarkFormatter,
      },
      localization: { timeFormatter },
    });
    candles.current = api.addSeries(CandlestickSeries, {
      upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down, borderVisible: false,
    });
    volumes.current = api.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
    volumes.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.current = api;
    return () => {
      api.remove();
      chart.current = candles.current = volumes.current = null;
      indicatorSeries.current = [];
      lastT.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candles.current || !volumes.current) return;
    const at = lastT.current === null ? -1 : bars.findIndex((b) => b.t === lastT.current);
    if (lastT.current !== null && at >= 0 && at === bars.length - 1) return; // nothing new
    if (at >= 0) {
      for (const b of bars.slice(at + 1)) {
        candles.current.update(candle(b));
        volumes.current.update(volume(b));
      }
    } else {
      candles.current.setData(bars.map(candle));
      volumes.current.setData(bars.map(volume));
      chart.current?.timeScale().scrollToRealTime();
    }
    lastT.current = bars.length ? bars[bars.length - 1].t : null;
  }, [bars]);

  useEffect(() => {
    if (!chart.current || !candles.current) return;
    const c = colors();
    chart.current.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.grid },
      timeScale: { borderColor: c.grid },
    });
    candles.current.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    volumes.current?.setData(bars.map(volume)); // the bars carry their colour
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // Indicators are rebuilt as a whole whenever a result arrives (bars, periods, theme).
  useEffect(() => {
    const api = chart.current;
    if (!api) return;
    for (const s of indicatorSeries.current) api.removeSeries(s);
    indicatorSeries.current = [];
    const stale = (v: Series | undefined) => v !== undefined && v.length !== bars.length;
    const all = [result.sma, result.ema, result.rsi, result.macd?.macd, result.bollinger?.mid];
    if (!all.some(stale)) {
      const line = (v: Series, color: string, style: LineStyle, pane = 0, width: 1 | 2 = 1) => {
        const s = api.addSeries(LineSeries, {
          color, lineStyle: style, lineWidth: width, priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: false,
        }, pane);
        s.setData(points(bars, v));
        indicatorSeries.current.push(s);
        return s;
      };
      const ind = (n: number) => css(`--ind-${n}`);
      if (result.sma) line(result.sma, ind(1), LineStyle.Solid, 0, 2);
      if (result.ema) line(result.ema, ind(2), LineStyle.Dashed, 0, 2);
      if (result.bollinger) {
        line(result.bollinger.upper, ind(3), LineStyle.Solid);
        line(result.bollinger.mid, ind(3), LineStyle.Dotted);
        line(result.bollinger.lower, ind(3), LineStyle.Solid);
      }
      let pane = 1;
      if (result.rsi) {
        const s = line(result.rsi, ind(4), LineStyle.Solid, pane, 2);
        s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
        for (const level of [30, 70]) {
          s.createPriceLine({ price: level, color: css("--muted"), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "" });
        }
        pane++;
      }
      if (result.macd) {
        const h = api.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
        h.setData(result.macd.hist.flatMap((v, i) => v === null ? [] : [{
          time: bars[i].t as UTCTimestamp, value: v, color: ind(4) + (v >= 0 ? "aa" : "55"),
        }]));
        indicatorSeries.current.push(h);
        line(result.macd.macd, ind(1), LineStyle.Solid, pane, 2);
        line(result.macd.signal, ind(5), LineStyle.Dashed, pane);
      }
      const all = api.panes();
      all[0]?.setStretchFactor(all.length > 1 ? 3 : 1);
    }
    setPanes(api.panes().length);
  }, [result, theme, bars]);

  return (
    <>
      <div className="chart-tools">
        <IndicatorMenu prefs={prefs} onChange={changePrefs} />
      </div>
      <div className="chart" data-testid="chart" data-bars={bars.length} data-panes={panes}
        data-indicators={prefs.enabled.join(",")} ref={host}>
        {bars.length === 0 && <div className="empty">Noch keine Kurse bis zu dieser Zeit.</div>}
      </div>
    </>
  );
}
