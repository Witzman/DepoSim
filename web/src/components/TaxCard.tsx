import { useEffect, useState } from "react";
import { getTax, putTax } from "../api.js";
import { DISCLAIMER, FUND_LABEL, frictionText, holdText } from "../taxText.js";
import { basisLabel, formatEur, parseEuro, formatPercentPlain, formatRatio, signedEur, signedPercent } from "../format.js";
import type { DepotView, FundType, TaxReport } from "../types.js";
import { Hint } from "./Hint.js";
import { poll } from "../poll.js";

const REFRESH_MS = 8000;
const DATE = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" });

/** Gross and net depot value as two lines, on one scale. A text summary stands for the picture. */
function NetChart({ curve }: { curve: NonNullable<TaxReport["report"]>["curve"] }) {
  if (curve.length < 2) return <p className="muted">Zu wenige Punkte für eine Kurve.</p>;
  const W = 640;
  const H = 180;
  const L = 78;
  const t0 = curve[0].t;
  const t1 = curve[curve.length - 1].t;
  const all = curve.flatMap((p) => [p.gross, p.net]);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const X = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - 8);
  const Y = (v: number) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (H - 26);
  const line = (f: (p: (typeof curve)[number]) => number) => curve.map((p) => `${X(p.t).toFixed(1)},${Y(f(p)).toFixed(1)}`).join(" ");
  const last = curve[curve.length - 1];
  return (
    <figure className="rolling-fig">
      <svg viewBox={`0 0 ${W} ${H}`} className="rolling-svg" role="img" data-testid="tax-chart"
        aria-label={`Depotwert brutto ${formatEur(last.gross)}, netto nach Steuern ${formatEur(last.net)}`}>
        <line x1={L} x2={W - 8} y1={Y(lo)} y2={Y(lo)} className="axis" />
        <text x={L - 4} y={Y(hi) + 4} textAnchor="end" className="tick">{formatEur(hi)}</text>
        <text x={L - 4} y={Y(lo)} textAnchor="end" className="tick">{formatEur(lo)}</text>
        <text x={L} y={H - 4} className="tick">{DATE.format(t0 * 1000)}</text>
        <text x={W - 8} y={H - 4} textAnchor="end" className="tick">{DATE.format(t1 * 1000)}</text>
        <polyline fill="none" stroke="var(--series-1)" strokeWidth={2} points={line((p) => p.gross)} />
        <polyline fill="none" stroke="var(--series-2)" strokeWidth={2} strokeDasharray="6 4" points={line((p) => p.net)} />
      </svg>
      <figcaption className="legend">
        <span><span className="swatch" style={{ borderTopColor: "var(--series-1)" }} aria-hidden="true" /> Brutto (wie gebucht) <span className="num muted">{formatEur(last.gross)}</span></span>
        <span><span className="swatch" style={{ borderTopColor: "var(--series-2)", borderTopStyle: "dashed" }} aria-hidden="true" /> Netto (Schätzung) <span className="num muted">{formatEur(last.net)}</span></span>
      </figcaption>
    </figure>
  );
}

interface Props { simulationId: number; depot: DepotView; running: boolean }

/** The after-tax view: switch, settings, years, the net curve and the friction. Everything is an estimate and says so. */
export function TaxCard({ simulationId, depot, running }: Props) {
  const [data, setData] = useState<TaxReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowance, setAllowance] = useState("");
  const ghost = depot.kind === "ghost";
  const fills = depot.orders.filter((o) => o.status === "filled").length;
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (ghost) return;
    let alive = true;
    const load = () => getTax(simulationId, depot.id).then((d) => { if (alive) { setData(d); setError(null); } }).catch((e: Error) => { if (alive) setError(e.message); });
    void load();
    const stop = running ? poll(load, REFRESH_MS) : undefined;
    return () => { alive = false; stop?.(); };
  }, [simulationId, depot.id, ghost, running, fills, version]);

  useEffect(() => {
    if (data) setAllowance(data.settings.allowance === null ? "" : String(data.settings.allowance).replace(".", ","));
  }, [data?.settings.allowance]); // eslint-disable-line react-hooks/exhaustive-deps

  // The controls follow the person at once; the figures follow when the server has the settings.
  const save = (patch: Parameters<typeof putTax>[1]) => {
    setData((d) => (d ? { ...d, settings: { ...d.settings, ...patch, fundTypes: { ...d.settings.fundTypes, ...patch.fundTypes } } } : d));
    return putTax(simulationId, patch).then(() => setVersion((v) => v + 1)).catch((e: Error) => setError(e.message));
  };

  if (ghost) return null;
  const r = data?.report ?? null;
  return (
    <section className="card tax" aria-label="Nach Steuern" data-testid="tax">
      <h2>Nach Steuern (Schätzung)<Hint id="afterTax" /></h2>
      <p className="warn-note" data-testid="tax-disclaimer" role="note">{DISCLAIMER}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <div className="rolling-controls">
            <label><input type="checkbox" checked={data.settings.enabled} data-testid="tax-switch" onChange={(e) => void save({ enabled: e.target.checked })} /> Nach Steuern anzeigen</label>
            <label>Kirchensteuer{" "}
              <select value={data.settings.church} data-testid="tax-church" onChange={(e) => void save({ church: Number(e.target.value) })}>
                <option value={0}>keine</option><option value={0.08}>8 %</option><option value={0.09}>9 %</option>
              </select>
            </label>
            <label>Freibetrag je Jahr (€){" "}
              <input inputMode="decimal" value={allowance} placeholder={String(data.rules.allowance).replace(".", ",")} className="narrow-input" data-testid="tax-allowance"
                onChange={(e) => setAllowance(e.target.value)}
                onBlur={() => {
                  const n = parseEuro(allowance);
                  if (n !== null || allowance.trim() === "") void save({ allowance: n });
                }} />
            </label>
          </div>
          <p className="muted num" data-testid="tax-rules">
            Satz {formatPercentPlain(data.rules.rate)} (25 % plus Soli{data.settings.church ? " und Kirchensteuer" : ""}), Freibetrag {formatEur(data.rules.allowance * 100)}{data.rules.allowanceIsDefault ? " (gesetzlich im Jahr der Simulationszeit)" : " (eigener Wert)"}. Regeln Stand {data.rules.asOf}.
          </p>
        </>
      )}
      {data && !data.enabled && <p className="muted" data-testid="tax-off">Aus. Die Auswertung oben bleibt brutto, wie gebucht.</p>}
      {data && data.enabled && data.funds.length > 0 && (
        <div className="rolling-controls" data-testid="tax-funds">
          {data.funds.map((f) => (
            <label key={f.symbol}>{f.symbol}{" "}
              <select value={f.type} onChange={(e) => void save({ fundTypes: { [f.symbol]: e.target.value as FundType } })}>
                {(Object.keys(FUND_LABEL) as FundType[]).map((k) => <option key={k} value={k}>{FUND_LABEL[k]}</option>)}
              </select>
              {f.isDefault && <span className="muted"> (Annahme)</span>}
            </label>
          ))}
        </div>
      )}
      {r && data && (
        <>
          {r.years.length === 0 ? <p className="muted" data-testid="tax-empty">Noch nichts realisiert: ohne Verkauf und ohne Ausschüttung gibt es keine Steuer.</p> : (
            <div className="scroll">
              <table className="positions num stacked" data-testid="tax-years">
                <caption className="sr-only">Steuer je Kalenderjahr</caption>
                <thead><tr><th scope="col">Jahr</th><th scope="col">Aktien-Topf</th><th scope="col">Allgemeiner Topf</th><th scope="col">Verlustvortrag ein</th><th scope="col">Freibetrag</th><th scope="col">Zu versteuern</th><th scope="col">Steuer</th></tr></thead>
                <tbody>
                  {r.years.map((y) => (
                    <tr key={y.year}>
                      <th scope="row">{y.year}</th>
                      <td data-label="Aktien-Topf">{signedEur(y.stockNet)}</td><td data-label="Allgemeiner Topf">{signedEur(y.otherNet)}</td>
                      <td data-label="Verlustvortrag ein">{formatEur(y.carryInStock + y.carryInOther)}</td><td data-label="Freibetrag">{formatEur(y.allowance)}</td>
                      <td data-label="Zu versteuern">{formatEur(y.taxable)}</td><td data-label="Steuer"><strong>{formatEur(y.tax)}</strong></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><th scope="row">Summe</th><td colSpan={5} /><td data-testid="tax-total"><strong>{formatEur(r.total)}</strong></td></tr></tfoot>
              </table>
            </div>
          )}
          <NetChart curve={r.curve} />
          <table className="positions num" data-testid="tax-compare">
            <caption className="sr-only">Brutto und netto im Vergleich</caption>
            <thead><tr><th scope="col">Kennzahl ({basisLabel(r.gross.basis)})</th><th scope="col">Brutto (wie gebucht)</th><th scope="col">Netto (Schätzung)</th></tr></thead>
            <tbody>
              <tr><th scope="row">Rendite</th><td>{r.gross.totalReturn === null ? "—" : signedPercent(r.gross.totalReturn)}</td><td data-testid="tax-net-return">{r.net.totalReturn === null ? "—" : signedPercent(r.net.totalReturn)}</td></tr>
              <tr><th scope="row">Sharpe</th><td>{formatRatio(r.gross.sharpe)}</td><td>{formatRatio(r.net.sharpe)}</td></tr>
              <tr><th scope="row">Größter Rückgang</th><td>{formatPercentPlain(r.gross.maxDrawdown)}</td><td>{formatPercentPlain(r.net.maxDrawdown)}</td></tr>
            </tbody>
          </table>
          <h3>Reibung: Gebühren und Steuern</h3>
          <p data-testid="tax-friction">{frictionText(r)}</p>
          <h3>Fiktiver Vergleich: Halten bis zum Ende</h3>
          <p data-testid="tax-hold">{holdText(r)}</p>
        </>
      )}
      {data && <p className="muted" data-testid="tax-vorab">{data.vorabpauschale.reason}</p>}
      {data && <details><summary>Quellen der Regeln</summary><ul className="plain-list">{data.rules.sources.map((s) => <li key={s}>{s}</li>)}</ul></details>}
    </section>
  );
}
