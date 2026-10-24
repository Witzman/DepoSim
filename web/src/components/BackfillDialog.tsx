import { useEffect, useRef, useState } from "react";
import { getBackfill, getMissing, getVenues, startBackfill } from "../api.js";
import type { BackfillJob, MissingList, VenueInfo } from "../types.js";

const POLL_MS = 2000;

interface Props {
  open: boolean;
  onClose: () => void;
}

/** What is missing in the archive, a button to fetch it, the progress, and the report. */
export function BackfillDialog({ open, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [missing, setMissing] = useState<MissingList | null>(null);
  const [venues, setVenues] = useState<VenueInfo[]>([]);
  const [job, setJob] = useState<BackfillJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    Promise.all([getMissing(), getBackfill()])
      .then(([m, j]) => { setMissing(m); setJob(j); setError(null); })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setMissing(null);
      setError(null);
      d.showModal();
      void refresh();
      getVenues().then(setVenues).catch(() => setVenues([]));
    }
    if (!open && d.open) d.close();
  }, [open]);

  // While a job runs, ask for its state every two seconds; when it ends, read what is missing again.
  const running = job?.running === true;
  useEffect(() => {
    if (!open || !running) return;
    const timer = setInterval(() => {
      getBackfill()
        .then((j) => { setJob(j); if (!j.running) void getMissing().then(setMissing).catch(() => {}); })
        .catch((e: Error) => setError(e.message));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, running]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setJob(await startBackfill());
    } catch (e) {
      setError((e as Error).message); // 409: the reason as the server words it
    } finally {
      setBusy(false);
    }
  }

  const report = job?.report ?? null;
  const blocked = missing?.blocked ?? null;
  const inReach = missing?.items.filter((i) => i.inReach).length ?? 0;
  const canStart = !!missing && blocked === null && !running && !busy && inReach > 0;
  const percent = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <dialog ref={dialog} className="backfill" aria-label="Fehlende Kurse nachladen" onClose={onClose}>
      <div className="stack">
        <h2>Fehlende Kurse nachladen</h2>

        {missing && (
          <section aria-label="Was fehlt" data-testid="backfill-missing">
            <p>
              <strong className="num">{missing.items.length}</strong> fehlende Kursdaten (Wertpapier und Tag) in den letzten{" "}
              <span className="num">{missing.days}</span> Tagen
              {inReach < missing.items.length && <>, davon <span className="num">{inReach}</span> in Reichweite der Quelle</>}.
            </p>
            {missing.daysIsAssumption && (
              <p className="muted" data-testid="backfill-assumption">
                Die Spanne von {missing.days} Tagen ist eine Annahme, nicht gemessen. Die Quelle liefert Minutenkurse nur
                für die letzten {missing.reachDays} Tage.
              </p>
            )}
            {missing.items.length > 0 && (
              <details>
                <summary>Liste der fehlenden Tage</summary>
                <div className="scroll missing-list">
                  <table className="positions num">
                    <thead><tr><th>Wertpapier</th><th>Tag</th><th>Stand</th></tr></thead>
                    <tbody>
                      {missing.items.map((i) => (
                        <tr key={`${i.symbol}-${i.day}`}>
                          <td>{i.symbol}</td><td>{i.day}</td>
                          <td>{i.state === "never" ? "nie geladen" : "unvollständig"}{i.inReach ? "" : " · außer Reichweite"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </section>
        )}

        {blocked && <p className="banner" role="status" data-testid="backfill-blocked">{blocked}</p>}
        {error && <p className="error" role="alert" data-testid="backfill-error">{error}</p>}

        {job && (running || report) && (
          <section aria-label="Fortschritt" data-testid="backfill-progress">
            {running ? (
              <>
                <progress max={job.total} value={job.done} aria-label="Fortschritt des Nachladens" />
                <p className="num" role="status">{job.done} von {job.total} ({percent} %) · läuft …</p>
              </>
            ) : null}
            {job.error && <p className="error" role="alert">Abgebrochen: {job.error}</p>}
          </section>
        )}

        {report && !running && (
          <section aria-label="Bericht" data-testid="backfill-report">
            <h3>Bericht</h3>
            {report.stoppedByRateLimit && (
              <p className="banner" role="status" data-testid="backfill-429">
                Abgebrochen: Die Quelle hat mit 429 (zu viele Anfragen) abgelehnt. Der Rest wurde nicht versucht; später erneut starten.
              </p>
            )}
            <p className="num" data-testid="backfill-counts">
              geladen {report.counts.loaded} · leer {report.counts.empty} · Fehler {report.counts.error} ·
              übersprungen {report.counts.skipped} · außerhalb der Reichweite {report.counts.outOfRange}
            </p>
            {report.items.length > 0 && (
              <div className="scroll missing-list">
                <table className="positions num">
                  <thead><tr><th>Wertpapier</th><th>Tag</th><th>Ergebnis</th></tr></thead>
                  <tbody>
                    {report.items.map((i) => (
                      <tr key={`${i.symbol}-${i.day}`} title={i.reason}>
                        <td>{i.symbol}</td><td>{i.day}</td>
                        <td>{i.status === "loaded" ? "✓" : i.status === "error" ? "✕" : "–"} {i.label}{i.bars !== undefined ? ` (${i.bars})` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {venues.length > 0 && (
          <section aria-label="Handelsplätze" data-testid="venue-list">
            <h3>Handelsplätze</h3>
            <ul className="venue-notes">
              {venues.map((v) => (
                <li key={v.id}>
                  <strong>{v.name}</strong> <span className="muted num">{v.opens}–{v.closes}</span>{" "}
                  <span className={v.hasSource ? "up" : "muted"}>{v.hasSource ? "✓ Kursquelle" : "○ keine Kursquelle"}</span>
                  <div className="muted">{v.note}</div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Schließen</button>
          <button type="button" className="btn primary" disabled={!canStart} onClick={() => void start()}>
            {running ? "Läuft …" : "Nachladen starten"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
