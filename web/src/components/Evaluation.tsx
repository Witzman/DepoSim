import { useEffect, useState } from "react";
import { getEvaluation } from "../api.js";
import { basisLabel, formatEur, formatPercentPlain, formatRatio, signedPercent } from "../format.js";
import { formatSimTime } from "../time.js";
import type { Evaluation as Data, Metrics, Slice } from "../types.js";

const REFRESH_MS = 5000;
const seriesColor = (i: number) => `var(--series-${(i % 8) + 1})`;

interface Props {
  simulationId: number;
  /** Shows the figures of the depot that is open, and refreshes while the clock runs. */
  activeDepotId: number;
  running: boolean;
  /** Changes when the benchmark does, so the figures are fetched again. */
  benchmark: string | null;
}

function Change({ ratio }: { ratio: number | null }) {
  if (ratio === null) return <>—</>;
  const cls = ratio > 0 ? "up" : ratio < 0 ? "down" : "muted";
  return <span className={cls}>{ratio > 0 ? "▲" : ratio < 0 ? "▼" : "•"} {signedPercent(ratio)}</span>;
}

function Bar({ title, slices }: { title: string; slices: Slice[] }) {
  const text = slices.map((s) => `${s.label} ${formatPercentPlain(s.share)}`).join(", ");
  return (
    <div className="dist" data-testid={`dist-${title}`}>
      <h3>{title}</h3>
      {slices.length === 0 ? <p className="muted">Noch nichts im Depot.</p> : (
        <>
          <div className="bar" role="img" aria-label={`${title}: ${text}`}>
            {slices.map((s, i) => <span key={s.label} style={{ width: `${s.share * 100}%`, background: seriesColor(i) }} />)}
          </div>
          <ul className="slices">
            {slices.map((s, i) => (
              <li key={s.label}>
                <span className="swatch" style={{ background: seriesColor(i) }} aria-hidden="true" />
                <span>{s.label}</span><span className="num">{formatPercentPlain(s.share)}</span>
                <span className="muted num">{formatEur(s.value)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function Evaluation({ simulationId, activeDepotId, running, benchmark }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = () =>
      getEvaluation(simulationId)
        .then((d) => current && (setData(d), setError(null)))
        .catch((e: Error) => current && setError(e.message));
    void load();
    const timer = running ? setInterval(load, REFRESH_MS) : undefined;
    return () => { current = false; if (timer) clearInterval(timer); };
  }, [simulationId, running, benchmark]);

  if (error) return <p className="banner error" role="alert">{error}</p>;
  if (!data) return <section className="card"><p className="muted">Lädt …</p></section>;

  const active = data.depots.find((d) => d.id === activeDepotId) ?? data.depots[0];
  const rows: { key: string; name: string; ghost?: boolean; since?: string; m: Metrics }[] = [
    ...data.depots.map((d) => ({ key: `d${d.id}`, name: d.name, ghost: d.kind === "ghost", since: formatSimTime(d.startedAt), m: d.metrics })),
    ...(data.benchmark ? [{ key: "bench", name: `Maßstab ${data.benchmark.symbol}`, m: data.benchmark.metrics }] : []),
  ];
  const anyBasis = rows.some((r) => r.m.basis);

  return (
    <>
      <section className="card" aria-label="Kennzahlen">
        <h2>Kennzahlen</h2>
        <div className="scroll">
          <table className="positions num stacked" data-testid="metrics">
            <thead><tr><th>Depot</th><th>Seit</th><th>Rendite</th><th>Basis</th><th>Volatilität p. a.</th><th>Max. Rückgang</th><th>Sharpe</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-testid={`metrics-${r.key}`}>
                  <td>{r.name}{r.ghost && <span className="badge ghost">Geist</span>}</td><td data-label="Seit">{r.since ?? "—"}</td>
                  <td data-label="Rendite"><Change ratio={r.m.totalReturn} /></td>
                  <td data-label="Basis">{basisLabel(r.m.basis)}</td>
                  <td data-label="Volatilität p. a.">{formatPercentPlain(r.m.volatility)}</td>
                  <td data-label="Max. Rückgang">{formatPercentPlain(r.m.maxDrawdown)}</td>
                  <td data-label="Sharpe">{formatRatio(r.m.sharpe)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.filter((r) => r.m.unavailable).slice(0, 1).map((r) => <p key={r.key} className="muted" data-testid="metrics-note">{r.m.unavailable}</p>)}
        {anyBasis && <p className="muted">Volatilität und Sharpe sind geschätzt aus den Werten der Spalte „Basis“, hochgerechnet auf ein Jahr. Sharpe ohne risikofreien Zins.</p>}

        <h3>Risiko</h3>
        <div className="scroll">
          <table className="positions num stacked" data-testid="risk">
            <thead><tr><th>Depot</th><th>Sortino</th><th>Calmar</th><th title="Verlust, den jeder zwanzigste Schritt erreicht oder übersteigt">Value at Risk 95 %</th><th>Bester Schritt</th><th>Schlechtester Schritt</th><th>Gewinnschritte</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-testid={`risk-${r.key}`}>
                  <td>{r.name}{r.ghost && <span className="badge ghost">Geist</span>}</td>
                  <td data-label="Sortino">{formatRatio(r.m.sortino)}</td>
                  <td data-label="Calmar">{formatRatio(r.m.calmar)}</td>
                  <td data-label="Value at Risk 95 %">{formatPercentPlain(r.m.var95)}</td>
                  <td data-label="Bester Schritt">{r.m.bestStep === null ? "—" : signedPercent(r.m.bestStep)}</td>
                  <td data-label="Schlechtester Schritt">{r.m.worstStep === null ? "—" : signedPercent(r.m.worstStep)}</td>
                  <td data-label="Gewinnschritte">{formatPercentPlain(r.m.upShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">Ein Schritt ist ein Wert der Spalte „Basis“. Calmar rechnet die Rendite auf ein Jahr hoch; bei kurzer Laufzeit ist das eine grobe Schätzung. Value at Risk ist historisch, aus den eigenen Schritten.</p>

        {data.benchmark && (
          <>
            <h3>Gegen den Maßstab {data.benchmark.symbol}</h3>
            <div className="scroll">
              <table className="positions num stacked" data-testid="relative">
                <thead><tr><th>Depot</th><th>Beta</th><th>Alpha p. a.</th><th>Tracking Error</th><th>Information Ratio</th><th>Besser als Maßstab</th></tr></thead>
                <tbody>
                  {data.depots.map((d) => (
                    <tr key={d.id} data-testid={`relative-${d.id}`}>
                      <td>{d.name}{d.kind === "ghost" && <span className="badge ghost">Geist</span>}</td>
                      <td data-label="Beta">{formatRatio(d.vsBenchmark?.beta ?? null)}</td>
                      <td data-label="Alpha p. a.">{d.vsBenchmark?.alpha == null ? "—" : signedPercent(d.vsBenchmark.alpha)}</td>
                      <td data-label="Tracking Error">{formatPercentPlain(d.vsBenchmark?.trackingError ?? null)}</td>
                      <td data-label="Information Ratio">{formatRatio(d.vsBenchmark?.informationRatio ?? null)}</td>
                      <td data-label="Besser als Maßstab">{formatPercentPlain(d.vsBenchmark?.hitShare ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.depots.every((d) => d.vsBenchmark === null) && <p className="muted">Noch zu wenige gemeinsame Werte für den Vergleich mit dem Maßstab.</p>}
            <p className="muted">Beta: wie stark das Depot den Schritten des Maßstabs folgt. Alpha: Mehrertrag darüber hinaus, hochgerechnet, ohne risikofreien Zins.</p>
          </>
        )}

        {data.depots.length > 1 && (
          <>
            <h3>Korrelation der Depots</h3>
            <div className="scroll">
              <table className="positions num stacked" data-testid="correlation">
                <thead><tr><th />{data.depots.map((d) => <th key={d.id}>{d.name}{d.kind === "ghost" && <span className="badge ghost">Geist</span>}</th>)}</tr></thead>
                <tbody>
                  {data.depots.map((d, i) => (
                    <tr key={d.id}>
                      <td>{d.name}{d.kind === "ghost" && <span className="badge ghost">Geist</span>}</td>
                      {data.correlation.matrix[i].map((x, j) => <td key={j} data-label={data.depots[j].name}>{formatRatio(x)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.correlation.basis === null
              ? <p className="muted">Noch zu wenige gemeinsame Werte für eine Korrelation.</p>
              : <p className="muted">Geschätzt; je kürzer die gemeinsame Zeit, desto feiner die Werte (bis {basisLabel(data.correlation.basis)}).</p>}
          </>
        )}
      </section>

      <section className="card" aria-label="Verteilung">
        <h2>Verteilung · {active.name}</h2>
        <Bar title="Sektor" slices={active.breakdown.sector} />
        <Bar title="Handelsland" slices={active.breakdown.country} />
        <Bar title="Währung" slices={active.breakdown.currency} />
        <p className="muted">Handelsland ist das Land der Börse, nicht der Firmensitz. Fonds stehen als „ETF/Fonds“.</p>
      </section>

      <section className="card" aria-label="Gebühren">
        <h2>Gebührenbilanz</h2>
        <div className="scroll">
          <table className="positions num stacked" data-testid="fees">
            <thead><tr><th>Depot</th><th>Orders</th><th>Provision</th><th>Auslandspauschale</th><th>Summe</th><th>vom Start</th></tr></thead>
            <tbody>
              {data.depots.map((d) => (
                <tr key={d.id} data-testid={`fees-${d.id}`}>
                  <td>{d.name}{d.kind === "ghost" && <span className="badge ghost">Geist</span>}</td><td data-label="Orders">{d.fees.orders}</td><td data-label="Provision">{formatEur(d.fees.commission)}</td>
                  <td data-label="Auslandspauschale">{formatEur(d.fees.foreign)}</td><td data-label="Summe">{formatEur(d.fees.total)}</td><td data-label="vom Start">{formatPercentPlain(d.fees.shareOfStart)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">Spread und Devisenaufschlag stecken im Ausführungspreis und fehlen hier.</p>
      </section>
    </>
  );
}
