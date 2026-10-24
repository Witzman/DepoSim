import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { getCurves } from "../api.js";
import { tickMarkFormatter, timeFormatter } from "../chartTime.js";
import { signedPercent } from "../format.js";
import type { Theme } from "../theme.js";
import type { BenchmarkCurve, Curve, DepotView, Instrument } from "../types.js";
import { normalize } from "../view.js";

const STYLES = [LineStyle.Solid, LineStyle.Dashed, LineStyle.Dotted, LineStyle.LargeDashed, LineStyle.SparseDotted];
const MIN_STEP_S = 60;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const seriesColor = (i: number) => css(`--series-${(i % 8) + 1}`);

interface Props {
  simulationId: number;
  /** The depots as they are now; each tick adds a point to the curves. */
  depots: DepotView[];
  simulationTime: number;
  theme: Theme;
  instruments: Instrument[];
  /** The symbol chosen as benchmark, if any, and its latest price. */
  benchmark: string | null;
  benchmarkPrice: number | undefined;
  onBenchmark: (symbol: string | null) => void;
}

/** The value of every depot as percent change since its start, side by side. */
export function Curves({ simulationId, depots, simulationTime, theme, instruments, benchmark, benchmarkPrice, onBenchmark }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const lines = useRef(new Map<number, ISeriesApi<"Line">>());
  const [curves, setCurves] = useState<Curve[]>([]);
  const [bench, setBench] = useState<BenchmarkCurve | null>(null);
  const benchLine = useRef<ISeriesApi<"Line"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idKey = depots.map((d) => d.id).join(",");

  // The stored curves: again when the set of depots changes.
  useEffect(() => {
    let current = true;
    getCurves(simulationId)
      .then((r) => current && (setCurves(r.depots), setBench(r.benchmark), setError(null)))
      .catch((e: Error) => current && setError(e.message));
    return () => { current = false; };
  }, [simulationId, idKey, benchmark]);

  // A new point per depot whenever the clock has moved a minute on.
  useEffect(() => {
    setCurves((prev) =>
      prev.map((c) => {
        const depot = depots.find((d) => d.id === c.id);
        const last = c.points[c.points.length - 1];
        if (!depot || !last || simulationTime - last.t < MIN_STEP_S) return c;
        return { ...c, points: [...c.points, { t: simulationTime, value: depot.value }] };
      }),
    );
    setBench((prev) => {
      const last = prev?.points[prev.points.length - 1];
      if (!prev || benchmarkPrice === undefined || (last && simulationTime - last.t < MIN_STEP_S)) return prev;
      return { ...prev, points: [...prev.points, { t: simulationTime, value: benchmarkPrice }] };
    });
  }, [simulationTime]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const api = createChart(host.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--surface") }, textColor: css("--muted") },
      grid: { vertLines: { color: css("--border") }, horzLines: { color: css("--border") } },
      rightPriceScale: { borderColor: css("--border") },
      timeScale: { borderColor: css("--border"), timeVisible: true, secondsVisible: false, tickMarkFormatter },
      localization: { timeFormatter, priceFormatter: (p: number) => `${p.toFixed(2).replace(".", ",")} %` },
    });
    chart.current = api;
    const map = lines.current;
    return () => {
      api.remove();
      chart.current = null;
      benchLine.current = null;
      map.clear();
    };
  }, []);

  useEffect(() => {
    const api = chart.current;
    if (!api) return;
    const c = { surface: css("--surface"), muted: css("--muted"), border: css("--border") };
    api.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.muted },
      grid: { vertLines: { color: c.border }, horzLines: { color: c.border } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    const wanted = new Set(curves.map((x) => x.id));
    for (const [id, series] of lines.current) {
      if (!wanted.has(id)) {
        api.removeSeries(series);
        lines.current.delete(id);
      }
    }
    if (benchLine.current && !bench) {
      api.removeSeries(benchLine.current);
      benchLine.current = null;
    }
    if (bench) {
      benchLine.current ??= api.addSeries(LineSeries, { lineWidth: 3, lineStyle: LineStyle.SparseDotted, priceLineVisible: false });
      benchLine.current.applyOptions({ color: c.muted });
      benchLine.current.setData(normalize(bench.points).map((p) => ({ time: p.t as UTCTimestamp, value: p.pct })));
    }
    curves.forEach((curve, i) => {
      let series = lines.current.get(curve.id);
      if (!series) {
        series = api.addSeries(LineSeries, { lineWidth: 2, lineStyle: STYLES[i % STYLES.length], priceLineVisible: false });
        lines.current.set(curve.id, series);
      }
      series.applyOptions({ color: seriesColor(i) });
      series.setData(normalize(curve.points).map((p) => ({ time: p.t as UTCTimestamp, value: p.pct })));
    });
    if (curves.some((x) => x.points.length > 1)) api.timeScale().fitContent();
  }, [curves, bench, theme]);

  return (
    <section className="card" aria-label="Kurvenvergleich">
      <div className="toolbar">
        <h2>Kurven seit Start (in Prozent)</h2>
        <label className="inline">Maßstab
          <select aria-label="Maßstab" value={benchmark ?? ""} onChange={(e) => onBenchmark(e.target.value || null)}>
            <option value="">keiner</option>
            {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol} · {i.name}</option>)}
          </select>
        </label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="chart curves" data-testid="curves" data-series={curves.length + (bench ? 1 : 0)} ref={host} />
      <ul className="legend" aria-label="Legende">
        {curves.map((c, i) => {
          const pts = normalize(c.points);
          const last = pts.length ? pts[pts.length - 1].pct : 0;
          const cls = last > 0 ? "up" : last < 0 ? "down" : "muted";
          return (
            <li key={c.id} data-testid={`legend-${c.id}`}>
              <span className="swatch" style={{ borderTopColor: seriesColor(i), borderTopStyle: i % 2 ? "dashed" : "solid" }} aria-hidden="true" />
              <span>{c.name}</span>
              <span className={`${cls} num`}>{last > 0 ? "▲" : last < 0 ? "▼" : "•"} {signedPercent(last / 100)}</span>
            </li>
          );
        })}
        {bench && (
          <li data-testid="legend-benchmark">
            <span className="swatch" style={{ borderTopColor: "var(--muted)", borderTopStyle: "dotted", borderTopWidth: 4 }} aria-hidden="true" />
            <span>Maßstab {bench.symbol}</span>
            <BenchChange points={bench.points} />
          </li>
        )}
      </ul>
      {bench && bench.currency === "USD" && <p className="muted">Der Maßstab ist der Kurs in Dollar, ohne Wechselkurs.</p>}
    </section>
  );
}

function BenchChange({ points }: { points: { t: number; value: number }[] }) {
  const pts = normalize(points);
  const last = pts.length ? pts[pts.length - 1].pct : 0;
  const cls = last > 0 ? "up" : last < 0 ? "down" : "muted";
  return <span className={`${cls} num`}>{last > 0 ? "▲" : last < 0 ? "▼" : "•"} {signedPercent(last / 100)}</span>;
}
