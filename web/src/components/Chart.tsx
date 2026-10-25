import {
  CandlestickSeries, ColorType, HistogramSeries, LineSeries, LineStyle, PriceScaleMode, createChart, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type MouseEventParams,
  type SeriesType, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CHART_TYPES, SCALE_MODES, TIMEFRAMES, TIMEFRAME_LABEL, aggregate, barChange, heikinAshi, type ChartPrefs, type Timeframe,
} from "../bars.js";
import { tickMarkFormatter, timeFormatter } from "../chartTime.js";
import { addDrawing, hitTest, newId, parse, removeDrawing, serialize, storageKey, type Drawing } from "../drawings.js";
import { loadPrefs, savePrefs, toConfig, type IndicatorPrefs } from "../indicatorPrefs.js";
import type { Series } from "../indicators.js";
import { useIndicators } from "../useIndicators.js";
import { signedPercent } from "../format.js";
import { markSeen } from "../guide.js";
import { DrawTools, type Tool } from "./DrawTools.js";
import { IndicatorMenu } from "./IndicatorMenu.js";
import type { Theme } from "../theme.js";
import type { Bar, MarketEvent } from "../types.js";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function colors() {
  return { text: css("--muted"), grid: css("--grid"), border: css("--border"), surface: css("--surface"), up: css("--up"), down: css("--down") };
}

/** A bar marked as an outlier (#50) is drawn hollow: no fill, only the outline in the colour of its direction. */
const candle = (b: Bar) => {
  const base = { time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c };
  if (!b.flagged) return base;
  const edge = b.c >= b.o ? css("--up") : css("--down");
  return { ...base, color: "rgba(0,0,0,0)", borderColor: edge, wickColor: edge };
};
const volume = (b: Bar) => ({
  time: b.t as UTCTimestamp, value: b.v, color: (b.c >= b.o ? css("--up") : css("--down")) + "66",
});

/** A filled order of the open depot, shown on the chart. */
export interface Fill { t: number; side: "buy" | "sell"; price: number; qty: number }

interface Props {
  /** One-minute bars; coarser timeframes are built from them here. */
  bars: Bar[];
  prefs: ChartPrefs;
  onPrefs: (p: ChartPrefs) => void;
  fills: Fill[];
  /** Dividends, splits and gaps of the shown symbol; each sits on the bar of its day. */
  events?: MarketEvent[];
  /** Shown first in the row of controls above the chart: the symbol choice and the last price. */
  lead?: ReactNode;
  theme: Theme;
  /** Drawings are kept per simulation and symbol. */
  simulationId: number | null;
  symbol: string;
  /** The timeframes offered; all of them by default. */
  timeframes?: Timeframe[];
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
export function Chart({ bars: raw, prefs: view, onPrefs, fills, events = [], lead, theme, simulationId, symbol, timeframes = TIMEFRAMES }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumes = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastT = useRef<number | null>(null);
  const indicatorSeries = useRef<ISeriesApi<SeriesType>[]>([]);
  const [prefs, setPrefs] = useState<IndicatorPrefs>(loadPrefs);
  const [panes, setPanes] = useState(1);
  const config = useMemo(() => toConfig(prefs), [prefs]);
  const bars = useMemo(() => aggregate(raw, view.timeframe), [raw, view.timeframe]);
  const display = useMemo(() => (view.type === "heikin" ? heikinAshi(bars) : bars), [bars, view.type]);
  const { result } = useIndicators(bars, config);
  const closeLine = useRef<ISeriesApi<"Line"> | null>(null);
  const dataKey = useRef("");
  const firstT = useRef<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const indexByTime = useMemo(() => new Map(display.map((b, i) => [b.t, i])), [display]);

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
  const changeDrawings = (next: Drawing[]) => { setDrawings(next); writeDrawings(key, next); if (next.length > drawings.length) markSeen("drawing"); };

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
    const times = bars.map((b) => b.t);
    const snap = (t: number) => {
      // the candle a fill belongs to: the last one that starts at or before it
      let lo = 0;
      let hi = times.length - 1;
      let at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return at;
    };
    const fillMarkers = fills.flatMap((f) => {
      const at = snap(f.t);
      if (at < 0) return [];
      const buy = f.side === "buy";
      return [{
        time: times[at] as UTCTimestamp, position: buy ? "belowBar" as const : "aboveBar" as const,
        shape: buy ? "arrowUp" as const : "arrowDown" as const, color: css(buy ? "--up" : "--down"),
        text: `${buy ? "K" : "V"} ${f.qty}`,
      }];
    });
    const eventMarkers = events.flatMap((e) => {
      if (e.t === null) return [];
      const at = snap(e.t);
      if (at < 0) return [];
      const gapUp = e.kind === "gap" && /\+\d/.test(e.text);
      return [{
        time: times[at] as UTCTimestamp, position: e.kind === "gap" && !gapUp ? "belowBar" as const : "aboveBar" as const,
        shape: e.kind === "gap" ? (gapUp ? "arrowUp" as const : "arrowDown" as const) : "square" as const,
        color: css(e.kind === "dividend" ? "--series-3" : e.kind === "split" ? "--series-4" : "--series-2"),
        text: e.kind === "dividend" ? "D" : e.kind === "split" ? "S" : "G",
      }];
    });
    markers.current?.setMarkers([
      ...drawings.flatMap((d) => d.kind === "marker" ? [{
        time: d.t as UTCTimestamp, position: "aboveBar" as const, shape: "arrowDown" as const, color, text: d.text,
      }] : []),
      ...fillMarkers,
      ...eventMarkers,
    ].sort((a, b) => (a.time as number) - (b.time as number)));
  }, [drawings, trendFirst, theme, fills, events, bars]);

  const changePrefs = (p: IndicatorPrefs) => { setPrefs(p); savePrefs(p); if (p.enabled.length > 0) markSeen("indicator"); };

  useEffect(() => {
    const c = colors();
    const api = createChart(host.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: {
        borderColor: c.border, timeVisible: true, secondsVisible: false,
        tickMarkFormatter,
      },
      crosshair: {
        vertLine: { color: c.text, labelBackgroundColor: css("--accent") },
        horzLine: { color: c.text, labelBackgroundColor: css("--accent") },
      },
      localization: { timeFormatter },
    });
    candles.current = api.addSeries(CandlestickSeries, {
      upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down, borderVisible: false,
    });
    closeLine.current = api.addSeries(LineSeries, {
      color: c.up, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false,
    });
    volumes.current = api.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
    volumes.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    markers.current = createSeriesMarkers(candles.current, []);
    api.subscribeClick((param) => onClick.current(param));
    api.subscribeCrosshairMove((param) => setHover(param.time === undefined ? null : (param.time as number)));
    chart.current = api;
    return () => {
      api.remove();
      chart.current = candles.current = volumes.current = closeLine.current = null;
      indicatorSeries.current = [];
      markers.current = null;
      drawn.current = { lines: [], series: [] };
      lastT.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candles.current || !volumes.current || !closeLine.current) return;
    const key = `${simulationId}|${symbol}|${view.timeframe}|${view.type}`;
    const changed = key !== dataKey.current;
    if (changed) { dataKey.current = key; lastT.current = null; }
    const at = lastT.current === null ? -1 : display.findIndex((b) => b.t === lastT.current);
    // Earlier history arriving (a longer stretch was fetched) cannot be added by updates: the data is set anew.
    const grewLeft = firstT.current !== null && display.length > 0 && display[0].t < firstT.current;
    if (at >= 0 && !grewLeft) {
      // the newest candle may still be growing: it is updated again, later ones are added
      for (const b of display.slice(at)) {
        candles.current.update(candle(b));
        closeLine.current.update({ time: b.t as UTCTimestamp, value: b.c });
        volumes.current.update(volume(b));
      }
    } else {
      candles.current.setData(display.map(candle));
      closeLine.current.setData(display.map((b) => ({ time: b.t as UTCTimestamp, value: b.c })));
      volumes.current.setData(display.map(volume));
      if (changed || !grewLeft) chart.current?.timeScale().scrollToRealTime();
    }
    lastT.current = display.length ? display[display.length - 1].t : null;
    if (!(at >= 0 && !grewLeft) || firstT.current === null) firstT.current = display.length ? display[0].t : null;
  }, [display, simulationId, symbol, view.timeframe, view.type]);

  // Line chart: the candles stay in place (the price scale, markers and drawings hang on them) but are invisible.
  useEffect(() => {
    if (!candles.current || !closeLine.current) return;
    const c = colors();
    const line = view.type === "line";
    const clear = "rgba(0,0,0,0)";
    candles.current.applyOptions(line
      ? { upColor: clear, downColor: clear, wickUpColor: clear, wickDownColor: clear, borderVisible: false }
      : { upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down, borderVisible: false });
    closeLine.current.applyOptions({ visible: line, color: css("--accent") });
  }, [view.type, theme]);

  useEffect(() => {
    chart.current?.priceScale("right").applyOptions({
      mode: view.scale === "log" ? PriceScaleMode.Logarithmic : view.scale === "percent" ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
    });
  }, [view.scale]);

  useEffect(() => {
    if (!chart.current || !candles.current) return;
    const c = colors();
    chart.current.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    volumes.current?.setData(display.map(volume)); // the bars carry their colour
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // Indicators are rebuilt as a whole whenever a result arrives (bars, periods, theme).
  useEffect(() => {
    const api = chart.current;
    if (!api) return;
    for (const s of indicatorSeries.current) api.removeSeries(s);
    indicatorSeries.current = [];
    const stale = (v: Series | undefined) => v !== undefined && v.length !== bars.length;
    const all = [result.sma, result.ema, result.rsi, result.macd?.macd, result.bollinger?.mid, result.vwap, result.atr, result.stoch?.k, result.obv];
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
      if (result.vwap) line(result.vwap, ind(5), LineStyle.Solid, 0, 2);
      let pane = 1;
      const bounded = (s: ISeriesApi<SeriesType>, levels: number[]) => {
        s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
        for (const level of levels) {
          s.createPriceLine({ price: level, color: css("--muted"), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "" });
        }
      };
      if (result.rsi) {
        bounded(line(result.rsi, ind(4), LineStyle.Solid, pane, 2), [30, 70]);
        pane++;
      }
      if (result.stoch) {
        bounded(line(result.stoch.k, ind(1), LineStyle.Solid, pane, 2), [20, 80]);
        line(result.stoch.d, ind(2), LineStyle.Dashed, pane);
        pane++;
      }
      if (result.atr) {
        line(result.atr, ind(3), LineStyle.Solid, pane, 2);
        pane++;
      }
      if (result.obv) {
        line(result.obv, ind(2), LineStyle.Solid, pane, 2);
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

  const shownIndex = hover !== null && indexByTime.has(hover) ? indexByTime.get(hover)! : display.length - 1;
  const legendBar = shownIndex >= 0 ? display[shownIndex] : null;
  const change = legendBar ? barChange(display, shownIndex) : null;
  const num = (x: number) => x.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

  return (
    <>
      <div className="chart-tools">
        {lead}
        <div className="seg" role="group" aria-label="Zeitrahmen" data-guide="timeframe">
          {timeframes.map((tf) => (
            <button key={tf} type="button" className="btn small" aria-pressed={view.timeframe === tf}
              data-testid={`tf-${tf}`} onClick={() => { markSeen("timeframe"); onPrefs({ ...view, timeframe: tf }); }}>{TIMEFRAME_LABEL[tf]}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Darstellung">
          {CHART_TYPES.map((t) => (
            <button key={t.id} type="button" className="btn small" aria-pressed={view.type === t.id}
              data-testid={`type-${t.id}`} onClick={() => onPrefs({ ...view, type: t.id })}>{t.label}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Preisskala">
          {SCALE_MODES.map((m) => (
            <button key={m.id} type="button" className="btn small" aria-pressed={view.scale === m.id}
              data-testid={`scale-${m.id}`} onClick={() => onPrefs({ ...view, scale: m.id })}>{m.label}</button>
          ))}
        </div>
        <IndicatorMenu prefs={prefs} onChange={changePrefs} />
        <DrawTools tool={tool} trendStarted={trendFirst !== null} markerPending={markerAt !== null}
          count={drawings.length} onTool={(t) => { setTool(t); setTrendFirst(null); setMarkerAt(null); }}
          onMarkerText={placeMarker} onClear={() => changeDrawings([])} />
      </div>
      <div className="chart-wrap">
        {legendBar && (
          <div className="legend-ohlc num" data-testid="ohlc" aria-live="off">
            <span className="sym">{symbol}</span>
            <span>O <b>{num(legendBar.o)}</b></span>
            <span>H <b>{num(legendBar.h)}</b></span>
            <span>T <b>{num(legendBar.l)}</b></span>
            <span>S <b>{num(legendBar.c)}</b></span>
            {change && (
              <span className={change.abs > 0 ? "up" : change.abs < 0 ? "down" : "muted"}>
                {change.abs > 0 ? "▲" : change.abs < 0 ? "▼" : "•"} {signedPercent(change.ratio)}
              </span>
            )}
            <span className="muted">Vol <b>{Math.round(legendBar.v).toLocaleString("de-DE")}</b></span>
            {view.type === "heikin" && <span className="muted">Heikin-Ashi</span>}
            {legendBar.flagged && (
              <span className="down" data-testid="ohlc-flagged" title="Die Kurskontrolle hält diesen Balken für einen Ausreißer: er löst keine Orders aus und gibt keinen Kurs.">
                Ausreißer, nicht handelbar
              </span>
            )}
          </div>
        )}
        <div className="chart" data-testid="chart" data-bars={bars.length} data-panes={panes}
          data-timeframe={view.timeframe} data-type={view.type} data-scale={view.scale}
          data-indicators={prefs.enabled.join(",")} data-drawings={drawings.length} ref={host}>
          {bars.length === 0 && <div className="empty">Noch keine Kurse bis zu dieser Zeit.</div>}
        </div>
      </div>
    </>
  );
}
