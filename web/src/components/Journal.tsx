import { Fragment, useEffect, useRef, useState } from "react";
import { BehaviorCard } from "./BehaviorCard.js";
import { ReviewSummary, TradeReviewDetail } from "./TradeReview.js";
import { getJournal, saveJournalNote } from "../api.js";
import { arrowOf, formatDuration, formatEur, formatPercentPlain, formatRatio, signedEurArrow, signedPercent } from "../format.js";
import { formatSimTime } from "../time.js";
import { tradeStats } from "../risk.js";
import { Hint } from "./Hint.js";
import type { DepotView, Journal as Data, JournalTrade } from "../types.js";

const REFRESH_MS = 5000;
export const NOTE_MAX = 500;

interface Props {
  simulationId: number;
  depot: DepotView;
  running: boolean;
  /** A daily simulation: times are dates. */
  daily?: boolean;
}

/** The note of one trade: written freely, saved when the field is left. */
function NoteField({ simulationId, trade, daily }: { simulationId: number; trade: JournalTrade; daily: boolean }) {
  const [text, setText] = useState(trade.note ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const dirty = useRef(false);
  const saved = useRef(trade.note ?? "");

  // A refresh from the server must not overwrite what is being typed.
  useEffect(() => {
    if (!dirty.current) { setText(trade.note ?? ""); saved.current = trade.note ?? ""; }
  }, [trade.note]);

  async function save() {
    if (!dirty.current || text === saved.current) { dirty.current = false; return; }
    setState("saving");
    try {
      const r = await saveJournalNote(simulationId, trade.key, text);
      saved.current = r.text;
      dirty.current = false;
      setText(r.text);
      setState("saved");
      setMessage(null);
    } catch (e) {
      setState("error");
      setMessage((e as Error).message);
    }
  }

  return (
    <div className="note">
      <input aria-label={`Notiz zu ${trade.symbol}, verkauft ${formatSimTime(trade.closedSim, daily)}`} data-testid={`note-${trade.key}`}
        value={text} maxLength={NOTE_MAX} placeholder="Notiz …"
        onChange={(e) => { dirty.current = true; setText(e.target.value); setState("idle"); }}
        onBlur={() => void save()} />
      <span className="muted" role="status" aria-live="polite">
        {state === "saving" ? "speichert …" : state === "saved" ? "✓ gespeichert" : ""}
      </span>
      {message && <span className="error" role="alert">{message}</span>}
    </div>
  );
}

export function Journal({ simulationId, depot, running, daily = false }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ghost = depot.kind === "ghost";
  const fills = depot.orders.filter((o) => o.status === "filled").length;

  // Another depot or simulation starts from nothing; a refresh of the same one keeps what is shown (and what is unfolded).
  useEffect(() => setData(null), [simulationId, depot.id]);

  useEffect(() => {
    if (ghost) return;
    let current = true;
    const load = () =>
      getJournal(simulationId, depot.id)
        .then((d) => current && (setData(d), setError(null)))
        .catch((e: Error) => current && setError(e.message));
    void load();
    const timer = running ? setInterval(load, REFRESH_MS) : undefined;
    return () => { current = false; if (timer) clearInterval(timer); };
  }, [simulationId, depot.id, ghost, running, fills]);

  return (
    <section className="card" aria-label="Journal" id="journal" data-testid="journal">
      <h2>Journal · {depot.name}</h2>
      {ghost && <p className="muted">Ein Geisterdepot hat kein Journal: Es handelt nicht.</p>}
      {!ghost && error && <p className="error" role="alert">{error}</p>}
      {!ghost && !data && !error && <p className="muted">Lädt …</p>}
      {!ghost && data && <JournalBody simulationId={simulationId} data={data} daily={daily} />}
    </section>
  );
}

function JournalBody({ simulationId, data, daily }: { simulationId: number; data: Data; daily: boolean }) {
  const stats = tradeStats(data.trades);
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  return (
    <>
      {data.fewData && <p><span className="badge warn" data-testid="few-data">wenig Daten</span> <span className="muted">Unter 5 abgeschlossene Trades: die Zahlen sagen wenig.</span></p>}
      <dl className="totals num journal-figures">
        <dt>Trefferquote<Hint id="hitRate" /></dt>
        <dd data-testid="hit-rate">
          {data.hitRate.rate === null ? "—" : formatPercentPlain(data.hitRate.rate)} <span className="muted">(n = {data.hitRate.n})</span>
        </dd>
        <dt>Haltedauer, Median<Hint id="holding" /></dt><dd data-testid="hold-median">{formatDuration(data.holding.medianSeconds)} <span className="muted">(n = {data.holding.n})</span></dd>
        <dt>Haltedauer, Mittel</dt><dd data-testid="hold-mean">{formatDuration(data.holding.meanSeconds)}</dd>
      </dl>
      {stats.n > 0 && (
        <>
          <h3>Handelsstatistik</h3>
          <dl className="totals num journal-figures" data-testid="trade-stats">
            <dt>Erwartungswert je Trade<Hint id="expectancy" /></dt><dd>{stats.expectancy === null ? "—" : signedEurArrow(stats.expectancy)}</dd>
            <dt>Ø Gewinn / Ø Verlust<Hint id="avgWinLoss" /></dt>
            <dd>{stats.avgWin === null ? "—" : formatEur(stats.avgWin)} / {stats.avgLoss === null ? "—" : formatEur(stats.avgLoss)}</dd>
            <dt>Gewinn-Verlust-Verhältnis<Hint id="payoff" /></dt><dd>{formatRatio(stats.payoff)}</dd>
            <dt>Profitfaktor<Hint id="profitFactor" /></dt><dd>{formatRatio(stats.profitFactor)}</dd>
            <dt>Bester / schlechtester Trade<Hint id="bestWorstTrade" /></dt>
            <dd>{stats.best === null ? "—" : signedEurArrow(stats.best)} / {stats.worst === null ? "—" : signedEurArrow(stats.worst)}</dd>
            <dt>Längste Verlustserie<Hint id="losingStreak" /></dt><dd>{stats.longestLosingStreak}</dd>
          </dl>
          <p className="muted">Profitfaktor: Summe der Gewinne durch Summe der Verluste; ohne Verlust-Trade gibt es keinen. Alles netto, nach Gebühren.</p>
        </>
      )}
      {data.hitRate.rate === null && <p className="muted">{data.hitRate.basis}</p>}
      {data.holding.medianSeconds === null && <p className="muted">{data.holding.basis}</p>}

      <h3>Abgeschlossene Trades</h3>
      {data.trades.length === 0 ? <p className="muted">Noch kein Trade abgeschlossen. Ein Trade ist ein Kauf, der ganz oder teilweise verkauft wurde.</p> : (
        <div className="scroll">
          <table className="positions num stacked" data-testid="journal-trades">
            <thead><tr><th>Wertpapier</th><th>Stück</th><th>Verkauft</th><th>Gehalten</th><th>Netto G/V</th><th>Notiz</th><th><span className="sr-only">Nachbetrachtung</span></th></tr></thead>
            <tbody>
              {data.trades.map((t) => (
                <Fragment key={t.key}>
                <tr data-testid={`trade-${t.key}`}>
                  <td>{t.symbol}</td><td data-label="Stück">{t.qty}</td><td data-label="Verkauft">{formatSimTime(t.closedSim, daily)}</td><td data-label="Gehalten">{formatDuration(t.holdSeconds)}</td>
                  <td data-label="Netto G/V" className={t.netPnl > 0 ? "up" : t.netPnl < 0 ? "down" : "muted"}>
                    {signedEurArrow(t.netPnl)}{t.netPct !== null && <span> ({arrowOf(t.netPct)} {signedPercent(t.netPct / 100)})</span>}
                  </td>
                  <td data-label="Notiz"><NoteField simulationId={simulationId} trade={t} daily={daily} /></td>
                  <td>
                    <button type="button" className="btn small" aria-expanded={reviewKey === t.key} data-testid={`review-toggle-${t.key}`}
                      onClick={() => setReviewKey(reviewKey === t.key ? null : t.key)}>Nachbetrachtung</button>
                  </td>
                </tr>
                {reviewKey === t.key && <tr><td colSpan={7}><TradeReviewDetail trade={t} e={data.excursions.trades[t.key]} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">Netto: nach Provision und Auslandspauschale. Gekauft und verkauft wird nach FIFO zugeordnet.</p>

      <ReviewSummary ex={data.excursions} trades={data.trades} />

      <BehaviorCard b={data.behavior} />

      <h3>Ausschüttungen und Splits</h3>
      {data.bookings.length === 0 ? <p className="muted">Noch keine Buchung. Ausschüttungen und Aktiensplits werden zum Ex-Tag gebucht, wenn das Depot die Aktie hält.</p> : (
        <ul className="plain num" data-testid="journal-bookings">
          {data.bookings.map((b) => <li key={`${b.kind}-${b.symbol}-${b.ref}`}>{formatSimTime(b.t, daily)} · {b.text}</li>)}
        </ul>
      )}
      <p className="muted">Zahltag = Ex-Tag (Annahme, Yahoo nennt nur den Ex-Tag). Ohne Steuer und Quellensteuer. Ein Aktiensplit wird gebucht, wenn die Kurse den Sprung zeigen; bereits bereinigte Kurse brauchen keine Buchung.</p>

      <h3>Offene Positionen</h3>
      {data.open.length === 0 ? <p className="muted">Keine offenen Positionen.</p> : (
        <ul className="plain num" data-testid="journal-open">
          {data.open.map((p) => (
            <li key={`${p.symbol}-${p.openedSim}`}>{p.symbol} · {p.qty} Stück · Kosten {formatEur(p.cost)} · seit {formatSimTime(p.openedSim, daily)}</li>
          ))}
        </ul>
      )}
      {data.excursions.open.length > 0 && (
        <ul className="plain num" data-testid="journal-open-review">
          {data.excursions.open.map((e) => (
            <li key={`${e.symbol}-${e.openedSim}`}>{e.symbol} bis jetzt: größter Rückgang {e.maePct === null ? "—" : formatPercentPlain(e.maePct / 100)}, größter Buchgewinn {e.mfePct === null ? "—" : formatPercentPlain(e.mfePct / 100)}</li>
          ))}
        </ul>
      )}

      <h3>Zu früh verkauft?<Hint id="tooEarly" /></h3>
      <p><strong data-testid="journal-note">{data.note}</strong></p>
      <div className="scroll">
        <table className="positions num stacked" data-testid="too-early">
          <thead><tr><th>Nach</th><th>Verkäufe (n)</th><th>noch offen</th><th>Quote „zu früh“</th><th>Ø Kursänderung</th></tr></thead>
          <tbody>
            {data.tooEarly.map((h) => (
              <tr key={h.days} data-testid={`too-early-${h.days}`}>
                <td>{h.days === 1 ? "1 Handelstag" : `${h.days} Handelstage`}</td>
                <td data-label="Verkäufe (n)">{h.n}</td><td data-label="noch offen">{h.open}</td>
                <td data-label="Quote „zu früh“">{h.rate === null ? "—" : `${formatPercentPlain(h.rate)} (${h.count} von ${h.n})`}</td>
                <td data-label="Ø Kursänderung" className={h.avgMovePct === null ? "muted" : h.avgMovePct > 0 ? "up" : h.avgMovePct < 0 ? "down" : "muted"}>
                  {h.avgMovePct === null ? "—" : `${arrowOf(h.avgMovePct)} ${signedPercent(h.avgMovePct / 100)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.tooEarly.filter((h) => h.rate === null || h.avgMovePct === null).map((h) => (
        <p key={h.days} className="muted">{h.days === 1 ? "1 Handelstag" : "5 Handelstage"}: {h.basis}</p>
      ))}
    </>
  );
}
