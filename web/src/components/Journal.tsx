import { useEffect, useRef, useState } from "react";
import { getJournal, saveJournalNote } from "../api.js";
import { arrowOf, formatDuration, formatEur, formatPercentPlain, signedEurArrow, signedPercent } from "../format.js";
import { formatSimTime } from "../time.js";
import type { DepotView, Journal as Data, JournalTrade } from "../types.js";

const REFRESH_MS = 5000;
export const NOTE_MAX = 500;

interface Props {
  simulationId: number;
  depot: DepotView;
  running: boolean;
}

/** The note of one trade: written freely, saved when the field is left. */
function NoteField({ simulationId, trade }: { simulationId: number; trade: JournalTrade }) {
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
      <input aria-label={`Notiz zu ${trade.symbol}, verkauft ${formatSimTime(trade.closedSim)}`} data-testid={`note-${trade.key}`}
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

export function Journal({ simulationId, depot, running }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ghost = depot.kind === "ghost";
  const fills = depot.orders.filter((o) => o.status === "filled").length;

  useEffect(() => {
    if (ghost) return;
    let current = true;
    setData(null);
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
      {!ghost && data && <JournalBody simulationId={simulationId} data={data} />}
    </section>
  );
}

function JournalBody({ simulationId, data }: { simulationId: number; data: Data }) {
  return (
    <>
      {data.fewData && <p><span className="badge warn" data-testid="few-data">wenig Daten</span> <span className="muted">Unter 5 abgeschlossene Trades: die Zahlen sagen wenig.</span></p>}
      <dl className="totals num journal-figures">
        <dt>Trefferquote</dt>
        <dd data-testid="hit-rate">
          {data.hitRate.rate === null ? "—" : formatPercentPlain(data.hitRate.rate)} <span className="muted">(n = {data.hitRate.n})</span>
        </dd>
        <dt>Haltedauer, Median</dt><dd data-testid="hold-median">{formatDuration(data.holding.medianSeconds)} <span className="muted">(n = {data.holding.n})</span></dd>
        <dt>Haltedauer, Mittel</dt><dd data-testid="hold-mean">{formatDuration(data.holding.meanSeconds)}</dd>
      </dl>
      {data.hitRate.rate === null && <p className="muted">{data.hitRate.basis}</p>}
      {data.holding.medianSeconds === null && <p className="muted">{data.holding.basis}</p>}

      <h3>Abgeschlossene Trades</h3>
      {data.trades.length === 0 ? <p className="muted">Noch kein Trade abgeschlossen. Ein Trade ist ein Kauf, der ganz oder teilweise verkauft wurde.</p> : (
        <div className="scroll">
          <table className="positions num" data-testid="journal-trades">
            <thead><tr><th>Wertpapier</th><th>Stück</th><th>Verkauft</th><th>Gehalten</th><th>Netto G/V</th><th>Notiz</th></tr></thead>
            <tbody>
              {data.trades.map((t) => (
                <tr key={t.key} data-testid={`trade-${t.key}`}>
                  <td>{t.symbol}</td><td>{t.qty}</td><td>{formatSimTime(t.closedSim)}</td><td>{formatDuration(t.holdSeconds)}</td>
                  <td className={t.netPnl > 0 ? "up" : t.netPnl < 0 ? "down" : "muted"}>
                    {signedEurArrow(t.netPnl)}{t.netPct !== null && <span> ({arrowOf(t.netPct)} {signedPercent(t.netPct / 100)})</span>}
                  </td>
                  <td><NoteField simulationId={simulationId} trade={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">Netto: nach Provision und Auslandspauschale. Gekauft und verkauft wird nach FIFO zugeordnet.</p>

      <h3>Offene Positionen</h3>
      {data.open.length === 0 ? <p className="muted">Keine offenen Positionen.</p> : (
        <ul className="plain num" data-testid="journal-open">
          {data.open.map((p) => (
            <li key={`${p.symbol}-${p.openedSim}`}>{p.symbol} · {p.qty} Stück · Kosten {formatEur(p.cost)} · seit {formatSimTime(p.openedSim)}</li>
          ))}
        </ul>
      )}

      <h3>Zu früh verkauft?</h3>
      <p><strong data-testid="journal-note">{data.note}</strong></p>
      <div className="scroll">
        <table className="positions num" data-testid="too-early">
          <thead><tr><th>Nach</th><th>Verkäufe (n)</th><th>noch offen</th><th>Quote „zu früh“</th><th>Ø Kursänderung</th></tr></thead>
          <tbody>
            {data.tooEarly.map((h) => (
              <tr key={h.days} data-testid={`too-early-${h.days}`}>
                <td>{h.days === 1 ? "1 Handelstag" : `${h.days} Handelstage`}</td>
                <td>{h.n}</td><td>{h.open}</td>
                <td>{h.rate === null ? "—" : `${formatPercentPlain(h.rate)} (${h.count} von ${h.n})`}</td>
                <td className={h.avgMovePct === null ? "muted" : h.avgMovePct > 0 ? "up" : h.avgMovePct < 0 ? "down" : "muted"}>
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
