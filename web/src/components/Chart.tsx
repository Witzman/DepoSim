import {
  CandlestickSeries, ColorType, HistogramSeries, createChart,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { tickMarkFormatter, timeFormatter } from "../chartTime.js";
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

/**
 * Candles with volume. New bars at the end are added one at a time; anything else
 * (another symbol, another simulation) replaces the data.
 */
export function Chart({ bars, theme }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumes = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastT = useRef<number | null>(null);

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

  return (
    <div className="chart" data-testid="chart" data-bars={bars.length} ref={host}>
      {bars.length === 0 && <div className="empty">Noch keine Kurse bis zu dieser Zeit.</div>}
    </div>
  );
}
