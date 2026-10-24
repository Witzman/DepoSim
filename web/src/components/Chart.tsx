import {
  CandlestickSeries, ColorType, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type MouseEventParams,
  type SeriesType, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { tickMarkFormatter, timeFormatter } from "../chartTime.js";
import { addDrawing, hitTest, newId, parse, removeDrawing, serialize, storageKey, type Drawing } from "../drawings.js";
import { loadPrefs, savePrefs, toConfig, type IndicatorPrefs } from "../indicatorPrefs.js";
import type { Series } from "../indicators.js";
import { useIndicators } from "../useIndicators.js";
import { DrawTools, type Tool } from "./DrawTools.js";
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
  /** Drawings are kept per simulation and symbol. */
  simulationId: number | null;
  symbol: string;
}

const HIT_PX = 8;

function readDrawings(key: string | null): Drawing[] {
  if (key === null) return [];
  try {
    return parse(localStorage.getItem(key));
  } catch {
    return [];
  }
}

function writeDrawings(key: string | null, list: Drawing[]) {
  if (key === null) return;
  try {
    if (list.length === 0) localStorage.removeItem(key); else localStorage.setItem(key, serialize(list));
  } catch { /* blocked storage: drawings last until the page is closed */ }
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
export function Chart({ bars, theme, simulationId, symbol }: Props) {
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

  // Drawings
  const key = simulationId === null ? null : storageKey(simulationId, symbol);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [tool, setTool] = useState<Tool | null>(null);
  const [trendFirst, setTrendFirst] = useState<{ t: number; price: number } | null>(null);
  const [markerAt, setMarkerAt] = useState<number | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const drawn = useRef<{ lines: IPriceLine[]; series: ISeriesApi<SeriesType>[] }>({ lines: [], series: [] });
  const onClick = useRef<(p: MouseEventParams<Time>) => void>(() => {});

  const cancelTool = () => { setTool(null); setTrendFirst(null); setMarkerAt(null); };
  const changeDrawings = (next: Drawing[]) => { setDrawings(next); writeDrawings(key, next); };

  useEffect(() => {
    cancelTool();
    setDrawings(readDrawings(key));
  }, [key]);

  useEffect(() => {
    if (tool === null && markerAt === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelTool(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tool, markerAt]);

  onClick.current = (param) => {
    const api = chart.current;
    const series = candles.current;
    if (!tool || !api || !series || !param.point) return;
    if (param.paneIndex !== undefined && param.paneIndex !== 0) return; // only the price pane
    const price = series.coordinateToPrice(param.point.y);
    const time = (param.time ?? api.timeScale().coordinateToTime(param.point.x)) as number | null;
    if (tool === "delete") {
      const id = hitTest(drawings, { x: param.point.x, y: param.point.y }, {
        x: (t) => api.timeScale().timeToCoordinate(t as UTCTimestamp),
        y: (p) => series.priceToCoordinate(p),
      }, HIT_PX);
      if (id) changeDrawings(removeDrawing(drawings, id));
      return;
    }
    if (price === null || time === null) return;
    if (tool === "hline") {
      changeDrawings(addDrawing(drawings, { id: newId(), kind: "hline", price }));
      setTool(null);
    } else if (tool === "trend") {
      if (!trendFirst) return setTrendFirst({ t: time, price });
      if (trendFirst.t === time) return; // a trend line needs two different times
      const [a, b] = trendFirst.t < time ? [trendFirst, { t: time, price }] : [{ t: time, price }, trendFirst];
      changeDrawings(addDrawing(drawings, { id: newId(), kind: "trend", a, b }));
      cancelTool();
    } else if (tool === "marker") {
      if (param.time !== undefined) setMarkerAt(param.time as number); // markers sit on a bar
    }
  };

  const placeMarker = (text: string | null) => {
    const t = markerAt;
    const clean = text?.trim().slice(0, 40);
    if (t !== null && clean) changeDrawings(addDrawing(drawings, { id: newId(), kind: "marker", t, text: clean }));
    cancelTool();
  };

  // Drawn objects are rebuilt whenever the list (or the theme's colours) changes.
  useEffect(() => {
    const api = chart.current;
    const candle = candles.current;
    if (!api || !candle) return;
    for (const l of drawn.current.lines) candle.removePriceLine(l);
    for (const s of drawn.current.series) api.removeSeries(s);
    drawn.current = { lines: [], series: [] };
    const color = css("--accent");
    for (const d of drawings) {
      if (d.kind === "hline") {
        drawn.current.lines.push(candle.createPriceLine({
          price: d.price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "",
        }));
      } else if (d.kind === "trend") {
        const s = api.addSeries(LineSeries, {
          color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        s.setData([{ time: d.a.t as UTCTimestamp, value: d.a.price }, { time: d.b.t as UTCTimestamp, value: d.b.price }]);
        drawn.current.series.push(s);
      }
    }
    if (trendFirst) {
      const s = api.addSeries(LineSeries, {
        color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        pointMarkersVisible: true,
      });
      s.setData([{ time: trendFirst.t as UTCTimestamp, value: trendFirst.price }]);
      drawn.current.series.push(s);
    }
    markers.current?.setMarkers(drawings
      .flatMap((d) => d.kind === "marker" ? [{
        time: d.t as UTCTimestamp, position: "aboveBar" as const, shape: "arrowDown" as const, color, text: d.text,
      }] : [])
      .sort((a, b) => (a.time as number) - (b.time as number)));
  }, [drawings, trendFirst, theme]);

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
    markers.current = createSeriesMarkers(candles.current, []);
    api.subscribeClick((param) => onClick.current(param));
    chart.current = api;
    return () => {
      api.remove();
      chart.current = candles.current = volumes.current = null;
      indicatorSeries.current = [];
      markers.current = null;
      drawn.current = { lines: [], series: [] };
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
        <DrawTools tool={tool} trendStarted={trendFirst !== null} markerPending={markerAt !== null}
          count={drawings.length} onTool={(t) => { setTool(t); setTrendFirst(null); setMarkerAt(null); }}
          onMarkerText={placeMarker} onClear={() => changeDrawings([])} />
      </div>
      <div className="chart" data-testid="chart" data-bars={bars.length} data-panes={panes}
        data-indicators={prefs.enabled.join(",")} data-drawings={drawings.length} ref={host}>
        {bars.length === 0 && <div className="empty">Noch keine Kurse bis zu dieser Zeit.</div>}
      </div>
    </>
  );
}
