import { chasingText, afterLossText, dispositionText, holdingText, tooEarlyText, turnoverText } from "../behaviorText.js";
import { formatDuration, formatEur, formatPercentPlain, formatRatio, signedEur } from "../format.js";
import type { Behavior } from "../types.js";
import { Hint } from "./Hint.js";

/** Patterns in how the trades were made: each with its number, the sample behind it and a plain sentence. No verdicts. */
export function BehaviorCard({ b }: { b: Behavior }) {
  const d = b.disposition;
  const fig = (x: number | null, f: (n: number) => string) => (x === null ? "—" : f(x));
  return (
    <section aria-label="Verhalten" data-testid="behavior">
      <h3>Verhalten</h3>
      {b.trades < b.minTrades && <p className="muted" data-testid="behavior-early">{tooEarlyText(b)}</p>}

      <h4>Dispositionseffekt<Hint id="disposition" /></h4>
      <dl className="totals num journal-figures" data-testid="behavior-disposition">
        <dt>Realisierte Gewinne / Verluste</dt><dd>{d.realizedGains} / {d.realizedLosses} <span className="muted">(n = {d.n})</span></dd>
        <dt>Offene Gewinne / Verluste an Verkaufstagen</dt><dd>{d.paperGains} / {d.paperLosses}</dd>
        <dt>PGR (Gewinne realisiert)</dt><dd data-testid="pgr">{d.ok ? fig(d.pgr, formatPercentPlain) : "—"}</dd>
        <dt>PLR (Verluste realisiert)</dt><dd data-testid="plr">{d.ok ? fig(d.plr, formatPercentPlain) : "—"}</dd>
        <dt>Verhältnis PGR / PLR</dt><dd data-testid="pgr-plr">{d.ok ? fig(d.ratio, formatRatio) : "—"}</dd>
      </dl>
      <p>{dispositionText(b)}</p>
      {d.unpriced > 0 && <p className="muted">{d.unpriced} offene Posten ohne bekannten Kurs am Verkaufstag sind nicht mitgezählt.</p>}

      <h4>Haltedauer: Gewinner gegen Verlierer</h4>
      <dl className="totals num journal-figures" data-testid="behavior-holding">
        <dt>Gewinner, Median</dt><dd>{b.holding.ok ? formatDuration(b.holding.winners.medianSeconds) : "—"} <span className="muted">(n = {b.holding.winners.n})</span></dd>
        <dt>Verlierer, Median</dt><dd>{b.holding.ok ? formatDuration(b.holding.losers.medianSeconds) : "—"} <span className="muted">(n = {b.holding.losers.n})</span></dd>
      </dl>
      <p>{holdingText(b)}</p>

      <h4>Umschlag<Hint id="turnover" /></h4>
      <dl className="totals num journal-figures" data-testid="behavior-turnover">
        <dt>Orders gesamt</dt><dd>{b.turnover.orders}</dd>
        <dt>Orders je Monat</dt><dd>{b.turnover.ok ? fig(b.turnover.ordersPerMonth, formatRatio) : "—"}</dd>
        <dt>Kaufvolumen je Jahr / mittleres Depot</dt><dd>{b.turnover.ok ? fig(b.turnover.yearlyTurnover, formatRatio) : "—"}</dd>
        <dt>Gebühren je Trade</dt><dd>{b.turnover.ok ? fig(b.turnover.feesPerTrade, (n) => formatEur(n)) : "—"}</dd>
        <dt>Gebührenanteil am Ergebnis vor Gebühren</dt><dd>{b.turnover.ok ? fig(b.turnover.feeShare, formatPercentPlain) : "—"}</dd>
      </dl>
      <p>{turnoverText(b)}</p>

      <h4>Hinterherlaufen<Hint id="chasing" /></h4>
      <dl className="totals num journal-figures" data-testid="behavior-chasing">
        <dt>Käufe nach Anstieg über 5 %</dt><dd>{b.chasing.ok ? fig(b.chasing.momentumShare, formatPercentPlain) : "—"} <span className="muted">(n = {b.chasing.n})</span></dd>
        <dt>Käufe nach Rücksetzer</dt><dd>{b.chasing.ok ? fig(b.chasing.pullbackShare, formatPercentPlain) : "—"}</dd>
      </dl>
      <p>{chasingText(b)}</p>

      <h4>Nach einem Verlust<Hint id="afterLoss" /></h4>
      <dl className="totals num journal-figures" data-testid="behavior-afterloss">
        <dt>Abstand zur nächsten Order, Median</dt><dd>{b.afterLoss.ok ? `${formatDuration(b.afterLoss.medianGapSeconds)} (sonst ${formatDuration(b.afterLoss.baselineGapSeconds)})` : "—"} <span className="muted">(n = {b.afterLoss.n})</span></dd>
        <dt>Größe der nächsten Order, Median</dt><dd>{b.afterLoss.ok ? `${fig(b.afterLoss.medianSize, (n) => formatEur(n))} (sonst ${fig(b.afterLoss.baselineSize, (n) => formatEur(n))})` : "—"}</dd>
      </dl>
      <p>{afterLossText(b)}</p>

      <h4>Tageszeit der Eröffnung</h4>
      {b.timeOfDay.ok ? (
        <table className="positions num" data-testid="behavior-hours">
          <thead><tr><th scope="col">Stunde (Ortszeit des Handelsplatzes)</th><th scope="col">Trades (n)</th><th scope="col">Gewinner</th><th scope="col">Netto G/V</th></tr></thead>
          <tbody>
            {b.timeOfDay.hours.map((h) => (
              <tr key={h.hour}><th scope="row">{String(h.hour).padStart(2, "0")}–{String((h.hour + 1) % 24).padStart(2, "0")} Uhr</th><td>{h.n}</td><td>{h.wins}</td><td className={h.netPnl > 0 ? "up" : h.netPnl < 0 ? "down" : "muted"}>{signedEur(h.netPnl)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted" data-testid="behavior-hours-reason">{b.timeOfDay.reason}</p>}
      <p className="muted">{b.note} Die Zahlen beschreiben, was geschah; sie sagen nichts über künftiges Verhalten.</p>
    </section>
  );
}
