import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { compareSimulations } from "../api.js";
import { MAX_COMPARE, elapsedSeries, toggleChoice } from "../compare.js";
import { arrowOf, formatDuration, formatEur, signedPercent } from "../format.js";
import type { Theme } from "../theme.js";
import type { CompareResult, Simulation } from "../types.js";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const seriesColor = (i: number) => css(`--series-${(i % 8) + 1}`);
const elapsedFormatter = (t: number) => (t === 0 ? "Start" : "+ " + formatDuration(t));

interface Props {
  simulations: Simulation[];
  /** Pre-chosen when the view opens. */
  initial: number[];
  theme: Theme;
}

function Pct({ value }: { value: number | null }) {
  if (value === null) return <>—</>;
  const cls = value > 0 ? "up" : value < 0 ? "down" : "muted";
  return <span className={cls}>{arrowOf(value)} {signedPercent(value / 100)}</span>;
}

/** Two to four simulations side by side: curves in percent, each on its own time since its start, and key figures. */
export function Compare({ simulations, initial, theme }: Props) {
  const [chosen, setChosen] = useState<number[]>(initial);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);

  // A simulation that is gone from the list leaves the choice.
  const present = chosen.filter((id) => simulations.some((s) => s.id === id));
  const key = present.join(",");

  useEffect(() => {
    if (present.length < 2) { setResult(null); setError(null); return; }
    let current = true;
    compareSimulations(present)
      .then((r) => current && (setResult(r), setError(null)))
      .catch((e: Error) => current && (setResult(null), setError(e.message)));
    return () => { current = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = result?.simulations.flatMap((s) => s.depots.map((d) => ({ sim: s, depot: d }))) ?? [];

  useEffect(() => {
    if (!host.current || rows.length === 0) return;
    const api = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--surface") }, textColor: css("--muted") },
      grid: { vertLines: { color: css("--border") }, horzLines: { color: css("--border") } },
      rightPriceScale: { borderColor: css("--border") },
      timeScale: { borderColor: css("--border"), tickMarkFormatter: elapsedFormatter, fixLeftEdge: true },
      localization: { timeFormatter: elapsedFormatter, priceFormatter: (p: number) => `${p.toFixed(2).replace(".", ",")} %` },
    });
    chart.current = api;
    rows.forEach(({ depot }, i) => {
      const line = api.addSeries(LineSeries, {
        lineWidth: 2, priceLineVisible: false, color: seriesColor(i),
        lineStyle: depot.kind === "ghost" ? LineStyle.LargeDashed : LineStyle.Solid,
      });
      line.setData(elapsedSeries(depot.points).map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    });
    api.timeScale().fitContent();
    return () => { api.remove(); chart.current = null; };
  }, [result, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card" aria-label="Simulationsvergleich" id="compare" data-testid="compare">
      <h2>Simulationsvergleich</h2>
      {simulations.length < 2 ? (
        <p className="muted" data-testid="compare-hint">Zum Vergleichen braucht es mindestens zwei Simulationen. Lege eine zweite an.</p>
      ) : (
        <fieldset className="choose">
          <legend className="muted">Zwei bis {MAX_COMPARE} Simulationen wählen</legend>
          {simulations.map((s) => {
            const on = present.includes(s.id);
            return (
              <label key={s.id} className="check">
                <input type="checkbox" checked={on} disabled={!on && present.length >= MAX_COMPARE}
                  onChange={() => setChosen(toggleChoice(present, s.id))} />
                <span>{s.name}</span>
              </label>
            );
          })}
        </fieldset>
      )}
      {simulations.length >= 2 && present.length < 2 && <p className="muted" data-testid="compare-pick">Wähle mindestens zwei.</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {result && (
        <>
          <p className="banner" data-testid="compare-note">{result.note}</p>
          <div className="chart curves" data-testid="compare-chart" data-series={rows.length} ref={host} />
          <p className="muted">Waagrecht: Zeit seit dem eigenen Start (jede Kurve hat ihre eigene Zeitachse). Gestrichelt: Geisterdepot.</p>
          <ul className="legend" aria-label="Legende Vergleich">
            {rows.map(({ sim, depot }, i) => (
              <li key={`${sim.id}-${depot.id}`}>
                <span className="swatch" style={{ borderTopColor: seriesColor(i), borderTopStyle: depot.kind === "ghost" ? "dashed" : "solid" }} aria-hidden="true" />
                <span>{sim.name} · {depot.name}{depot.kind === "ghost" ? " (Geist)" : ""}</span>
              </li>
            ))}
          </ul>
          <div className="scroll">
            <table className="positions num stacked" data-testid="compare-table">
              <thead><tr><th>Simulation</th><th>Depot</th><th>Rendite</th><th>Größter Rückgang</th><th>Gebühren</th><th>Trades</th></tr></thead>
              <tbody>
                {rows.map(({ sim, depot }) => (
                  <tr key={`${sim.id}-${depot.id}`} data-testid={`compare-row-${depot.id}`}>
                    <td>{sim.name}</td>
                    <td data-label="Depot">{depot.name}{depot.kind === "ghost" && <span className="badge ghost">Geist</span>}</td>
                    <td data-label="Rendite"><Pct value={depot.figures.returnPct} /></td>
                    <td data-label="Größter Rückgang">{depot.figures.maxDrawdownPct === null ? "—" : <Pct value={depot.figures.maxDrawdownPct} />}</td>
                    <td data-label="Gebühren">{formatEur(depot.figures.fees)}</td>
                    <td data-label="Trades">{depot.figures.trades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
