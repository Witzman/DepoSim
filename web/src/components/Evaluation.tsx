import { useEffect, useState } from "react";
import { getEvaluation } from "../api.js";
import { basisLabel, formatEur, formatPercentPlain, formatRatio, signedPercent } from "../format.js";
import { reliabilityOf } from "../glossary.js";
import { formatSimTime } from "../time.js";
import { Hint } from "./Hint.js";
import { PRESET_LABEL, describeRules } from "../rules.js";
import type { Diversification, Evaluation as Data, Metrics, Rules, Slice } from "../types.js";

const REFRESH_MS = 5000;
const seriesColor = (i: number) => `var(--series-${(i % 8) + 1})`;

interface Props {
  simulationId: number;
  /** Shows the figures of the depot that is open, and refreshes while the clock runs. */
  activeDepotId: number;
  running: boolean;
  /** Changes when the benchmark does, so the figures are fetched again. */
  benchmark: string | null;
  /** The rules of the simulation; results are only comparable with the same rules. */
  rules: Rules;
}

function Change({ ratio }: { ratio: number | null }) {
  if (ratio === null) return <>—</>;
  const cls = ratio > 0 ? "up" : ratio < 0 ? "down" : "muted";
  return <span className={cls}>{ratio > 0 ? "▲" : ratio < 0 ? "▼" : "•"} {signedPercent(ratio)}</span>;
}

/** "Zu früh zu sagen" or "Aussagekraft gering" with the reason, when the basis of a row says little. */
function Reliability({ m }: { m: Metrics }) {
  const r = reliabilityOf(m);
  if (!r) return null;
  return <span className="badge warn" title={r.reason} data-testid="reliability">{r.label}</span>;
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

const pct0 = (x: number) => `${Math.round(x * 100)} %`;

/** Concentration of the weights, then how the positions mix: correlation heatmap and risk share beside the money share. */
function Diversify({ d }: { d: Diversification | null }) {
  if (!d) return null;
  const c = d.concentration;
  const m = d.measured;
  return (
    <div className="dist" data-testid="diversification">
      <h3>Streuung der Positionen</h3>
      <dl className="totals num journal-figures" data-testid="concentration">
        <dt>Größte Position<Hint id="concentration" /></dt><dd>{pct0(c.largest)} <span className="muted">{c.weights[0]?.symbol}</span></dd>
        <dt>Größte drei</dt><dd>{pct0(c.top3)}</dd>
        <dt>Herfindahl-Index (HHI)</dt><dd>{formatRatio(c.hhi)}</dd>
        <dt>Wirkt wie so viele gleich große Positionen</dt><dd data-testid="effective-count">{formatRatio(c.effectiveCount)} <span className="muted">(gehalten: {c.weights.length})</span></dd>
      </dl>
      {!m ? <p className="muted" data-testid="diversification-reason">{d.reason}</p> : (
        <>
          <p className="muted" data-testid="diversification-basis">Aus {m.n} Renditen auf {basisLabel(m.basis)}, bis {formatSimTime(m.until)}.{m.left.length > 0 && ` Ohne ${m.left.join(", ")}: zu wenige gemeinsame Werte.`}</p>
          <h4>Korrelation der Positionen<Hint id="positionCorrelation" /></h4>
          <div className="scroll">
            <table className="positions num heat" data-testid="position-correlation">
              <thead><tr><th />{m.symbols.map((s) => <th key={s}>{s}</th>)}</tr></thead>
              <tbody>
                {m.symbols.map((s, i) => (
                  <tr key={s}>
                    <th scope="row">{s}</th>
                    {m.matrix[i].map((x, j) => <td key={j} className="cell" style={{ "--heat": Math.max(0, x) } as React.CSSProperties}>{formatRatio(x)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4>Anteil am Geld und am Risiko<Hint id="riskShare" /></h4>
          <div className="risk-bars" data-testid="risk-shares">
            {m.lines.map((l) => (
              <div className="pair" key={l.symbol}>
                <span>{l.symbol}</span>
                <span className="track" role="img" aria-label={`${l.symbol}: ${pct0(l.weight)} des Geldes, ${pct0(l.riskShare)} des Risikos`}>
                  <span className="weight" style={{ width: `${Math.min(l.weight, 1) * 100}%` }} />
                  <span className="risk" style={{ width: `${Math.min(Math.max(l.riskShare, 0), 1) * 100}%` }} />
                </span>
                <span className="num">{pct0(l.weight)} / {pct0(l.riskShare)}</span>
              </div>
            ))}
          </div>
          <p className="muted">Grau: Anteil am Geld. Farbe: Anteil am Risiko. Depot-Volatilität {formatPercentPlain(m.volatility)} p. a.; Diversifikationsquotient <strong data-testid="diversification-ratio">{formatRatio(m.ratio)}</strong><Hint id="diversificationRatio" />.</p>
          {m.remarks.map((r) => <p key={r} data-testid="diversification-remark">{r}</p>)}
        </>
      )}
      <p className="muted">Gewichte nach dem heutigen Wert, Renditen aus dem Fenster seit dem Start. Haben sich die Gewichte in dieser Zeit geändert, gilt die Rechnung für die Kurse der Positionen, nicht für das Depot. Ein ETF zählt als eine Position.</p>
    </div>
  );
}

export function Evaluation({ simulationId, activeDepotId, running, benchmark, rules }: Props) {
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
        <h2>Kennzahlen<span className="badge rules" data-testid="eval-rules" title={describeRules(rules)}>{PRESET_LABEL[rules.preset]}</span></h2>
        <div className="scroll">
          <table className="positions num stacked" data-testid="metrics">
            <thead><tr><th>Depot</th><th>Seit</th><th>Rendite<Hint id="return" /></th><th>Basis<Hint id="basis" /></th><th>Volatilität p. a.<Hint id="volatility" /></th><th>Max. Rückgang<Hint id="maxDrawdown" /></th><th>Sharpe<Hint id="sharpe" /></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-testid={`metrics-${r.key}`}>
                  <td>{r.name}{r.ghost && <span className="badge ghost">Geist</span>}</td><td data-label="Seit">{r.since ?? "—"}</td>
                  <td data-label="Rendite"><Change ratio={r.m.totalReturn} /></td>
                  <td data-label="Basis">{basisLabel(r.m.basis)}<Reliability m={r.m} /></td>
                  <td data-label="Volatilität p. a.">{formatPercentPlain(r.m.volatility)}</td>
                  <td data-label="Max. Rückgang">{formatPercentPlain(r.m.maxDrawdown)}</td>
                  <td data-label="Sharpe">{formatRatio(r.m.sharpe)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {[...new Set(rows.flatMap((r) => reliabilityOf(r.m) ?? []).map((r) => `${r.label}: ${r.reason}`))].map((t) => <p key={t} className="muted" data-testid="reliability-note">{t}</p>)}
        {rows.filter((r) => r.m.unavailable).slice(0, 1).map((r) => <p key={r.key} className="muted" data-testid="metrics-note">{r.m.unavailable}</p>)}
        <p className="muted">Die Depotkurve enthält gebuchte Ausschüttungen (mit Ausschüttungen, ohne Steuer); der Maßstab ist ein reiner Kurs ohne Ausschüttungen.</p>
        {anyBasis && <p className="muted">Volatilität und Sharpe sind geschätzt aus den Werten der Spalte „Basis“, hochgerechnet auf ein Jahr. Sharpe ohne risikofreien Zins.</p>}

        <h3>Risiko</h3>
        <div className="scroll">
          <table className="positions num stacked" data-testid="risk">
            <thead><tr><th>Depot</th><th>Sortino<Hint id="sortino" /></th><th>Calmar<Hint id="calmar" /></th><th>Value at Risk 95 %<Hint id="var95" /></th><th>Bester Schritt<Hint id="bestStep" /></th><th>Schlechtester Schritt<Hint id="worstStep" /></th><th>Gewinnschritte<Hint id="upShare" /></th></tr></thead>
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
                <thead><tr><th>Depot</th><th>Beta<Hint id="beta" /></th><th>Alpha p. a.<Hint id="alpha" /></th><th>Tracking Error<Hint id="trackingError" /></th><th>Information Ratio<Hint id="informationRatio" /></th><th>Besser als Maßstab<Hint id="hitShare" /></th></tr></thead>
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
            <h3>Korrelation der Depots<Hint id="correlation" /></h3>
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
        <h2>Verteilung · {active.name}<Hint id="distribution" /></h2>
        <Bar title="Sektor" slices={active.breakdown.sector} />
        <Bar title="Handelsland" slices={active.breakdown.country} />
        <Bar title="Währung" slices={active.breakdown.currency} />
        <Diversify d={active.diversification} />
        <p className="muted">Handelsland ist das Land der Börse, nicht der Firmensitz. Fonds stehen als „ETF/Fonds“.</p>
      </section>

      <section className="card" aria-label="Gebühren">
        <h2>Gebührenbilanz<Hint id="fees" /></h2>
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
