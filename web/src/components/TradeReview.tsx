import { benchmarkText, efficiencyText, entryText } from "../review.js";
import { formatEur, formatPercentPlain } from "../format.js";
import type { Excursion, Excursions, JournalTrade } from "../types.js";
import { Hint } from "./Hint.js";

/** The path of the price from entry to exit as a small line, with the buy and exit levels. */
function PathChart({ e, buy, exit }: { e: Excursion; buy: number; exit: number }) {
  if (e.path.length < 2) return null;
  const W = 240;
  const H = 70;
  const lo = Math.min(...e.path);
  const hi = Math.max(...e.path);
  const Y = (v: number) => 6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 12);
  const X = (i: number) => 4 + (i / (e.path.length - 1)) * (W - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="review-path" role="img" aria-label={`Kursverlauf des Trades von ${buy.toLocaleString("de-DE")} bis ${exit.toLocaleString("de-DE")}`}>
      <line x1={4} x2={W - 4} y1={Y(buy)} y2={Y(buy)} className="axis zero" strokeDasharray="3 3" />
      <polyline fill="none" stroke="var(--series-1)" strokeWidth={1.8} points={e.path.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")} />
      <circle cx={X(0)} cy={Y(e.path[0])} r={3} fill="var(--series-1)" />
      <circle cx={X(e.path.length - 1)} cy={Y(e.path[e.path.length - 1])} r={3} fill="var(--series-2)" />
    </svg>
  );
}

/** The detail of one closed trade: dip, peak, what the exit took, the entry and the benchmark check. */
export function TradeReviewDetail({ trade, e }: { trade: JournalTrade; e: Excursion | undefined }) {
  if (!e) return <p className="muted">Keine Nachbetrachtung vorhanden.</p>;
  return (
    <div className="review-detail" data-testid={`review-${trade.key}`}>
      <dl className="totals num journal-figures">
        <dt>Größter Rückgang (MAE)<Hint id="mae" /></dt>
        <dd>{e.maePct === null ? "—" : `${formatPercentPlain(e.maePct / 100)}${e.maeCents !== null ? ` · ca. ${formatEur(e.maeCents)}` : ""}`}</dd>
        <dt>Größter Buchgewinn (MFE)<Hint id="mfe" /></dt>
        <dd>{e.mfePct === null ? "—" : `${formatPercentPlain(e.mfePct / 100)}${e.mfeCents !== null ? ` · ca. ${formatEur(e.mfeCents)}` : ""}`}</dd>
        <dt>Exit-Effizienz<Hint id="exitEfficiency" /></dt>
        <dd data-testid="review-efficiency">{e.efficiency === null ? "—" : formatPercentPlain(e.efficiency)}</dd>
      </dl>
      <p>{efficiencyText(e)}</p>
      <p>{entryText(e)}</p>
      <p>{benchmarkText(e)}</p>
      <PathChart e={e} buy={trade.buyPrice} exit={trade.sellPrice} />
      <p className="muted">Kurse ohne Gebühren, aus {e.bars} Kerzen der Haltezeit. Euro-Beträge sind auf die Kosten des Postens umgerechnet (bei US-Werten eine Näherung).</p>
    </div>
  );
}

/** Over all closed trades: medians, the spread of the exit efficiency and MAE against the result. */
export function ReviewSummary({ ex, trades }: { ex: Excursions; trades: JournalTrade[] }) {
  const s = ex.summary;
  const pts = trades.flatMap((t) => {
    const e = ex.trades[t.key];
    return e && e.maePct !== null && t.netPct !== null ? [{ mae: e.maePct, net: t.netPct, key: t.key }] : [];
  });
  const max = Math.max(1, ...ex.summary.efficiencyBuckets.map((b) => b.count));
  const W = 320;
  const H = 150;
  const L = 36;
  const maeMax = Math.max(1, ...pts.map((p) => p.mae));
  const netLo = Math.min(0, ...pts.map((p) => p.net));
  const netHi = Math.max(0.1, ...pts.map((p) => p.net));
  const X = (v: number) => L + (v / maeMax) * (W - L - 8);
  const Y = (v: number) => 8 + (1 - (v - netLo) / (netHi - netLo || 1)) * (H - 24);
  return (
    <section aria-label="Nachbetrachtung" data-testid="review-summary">
      <h3>Nachbetrachtung</h3>
      {s.n === 0 ? <p className="muted" data-testid="review-empty">Noch kein abgeschlossener Trade mit Kursen für die Nachbetrachtung.</p> : (
        <>
          <dl className="totals num journal-figures">
            <dt>MAE, Median<Hint id="mae" /></dt><dd data-testid="review-mae">{s.medianMaePct === null ? "—" : formatPercentPlain(s.medianMaePct / 100)} <span className="muted">(n = {s.n})</span></dd>
            <dt>MFE, Median<Hint id="mfe" /></dt><dd>{s.medianMfePct === null ? "—" : formatPercentPlain(s.medianMfePct / 100)}</dd>
            <dt>Exit-Effizienz, Median<Hint id="exitEfficiency" /></dt><dd>{s.medianEfficiency === null ? "—" : formatPercentPlain(s.medianEfficiency)}</dd>
            <dt>Gegen den Maßstab{ex.benchmark ? ` (${ex.benchmark})` : ""}</dt>
            <dd>{s.benchmark.n === 0 ? "nicht berechenbar" : `${s.benchmark.beat} von ${s.benchmark.n} Trades darüber`}</dd>
          </dl>
          <table className="positions num" data-testid="review-buckets">
            <caption className="sr-only">Verteilung der Exit-Effizienz</caption>
            <thead><tr><th scope="col">Exit-Effizienz</th><th scope="col">Trades</th><th scope="col"><span className="sr-only">Balken</span></th></tr></thead>
            <tbody>
              {s.efficiencyBuckets.map((b) => (
                <tr key={b.label}><th scope="row">{b.label}</th><td>{b.count}</td><td><span className="review-bar" style={{ width: `${(b.count / max) * 100}%` }} aria-hidden="true" /></td></tr>
              ))}
            </tbody>
          </table>
          {pts.length >= 2 && (
            <figure className="rolling-fig">
              <svg viewBox={`0 0 ${W} ${H}`} className="rolling-svg" role="img" data-testid="review-scatter"
                aria-label={`Streudiagramm: größter Rückgang gegen Ergebnis von ${pts.length} Trades`}>
                <line x1={L} x2={W - 8} y1={Y(netLo)} y2={Y(netLo)} className="axis" />
                {netLo < 0 && <line x1={L} x2={W - 8} y1={Y(0)} y2={Y(0)} className="axis zero" />}
                <text x={L - 4} y={Y(netHi) + 4} textAnchor="end" className="tick">{formatPercentPlain(netHi / 100)}</text>
                <text x={L - 4} y={Y(netLo)} textAnchor="end" className="tick">{formatPercentPlain(netLo / 100)}</text>
                <text x={L} y={H - 2} className="tick">0 %</text>
                <text x={W - 8} y={H - 2} textAnchor="end" className="tick">MAE {formatPercentPlain(maeMax / 100)}</text>
                {pts.map((p) => <circle key={p.key} cx={X(p.mae)} cy={Y(p.net)} r={3.5} fill={p.net >= 0 ? "var(--up)" : "var(--down)"} fillOpacity={0.75} />)}
              </svg>
              <figcaption className="muted">Jeder Punkt ein Trade: rechts ein tieferer Rückgang, oben ein besseres Ergebnis (netto).</figcaption>
            </figure>
          )}
        </>
      )}
      <p className="muted">Beobachtung am Verlauf, keine Empfehlung für Stopp oder Ausstieg.</p>
    </section>
  );
}
