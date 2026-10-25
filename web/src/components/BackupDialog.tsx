import { useEffect, useRef, useState } from "react";
import { getBackupStatus, importSimulation, restoreBackup } from "../api.js";
import type { BackupStatus } from "../types.js";

interface Props {
  open: boolean;
  /** The selected simulation, if any: its export and CSV links. */
  simulationId: number | null;
  onClose: () => void;
  /** The server state was replaced or extended: the lists must be read again. */
  onChanged: (what: "restored" | "imported") => void;
}

const when = (s: number) => new Date(s * 1000).toLocaleString("de-DE");

/** Download a whole backup, restore from one, export or import a simulation, and the CSV downloads. */
export function BackupDialog({ open, simulationId, onClose, onChanged }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setFile(null);
      setConfirming(false);
      setError(null);
      setMessage(null);
      d.showModal();
      getBackupStatus().then(setStatus).catch((e: Error) => setError(e.message));
    }
    if (!open && d.open) d.close();
  }, [open]);

  async function restore() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await restoreBackup(file);
      setMessage(`Wiederhergestellt: ${result.simulations} Simulationen. Der vorherige Stand liegt als ${result.savedBefore} im Sicherungsordner.`);
      setFile(null);
      setConfirming(false);
      onChanged("restored");
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(f: File) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const sim = await importSimulation(f);
      setMessage(`Importiert als „${sim.name}“.`);
      onChanged("imported");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="backfill" aria-label="Sicherung, Export und Import" onClose={onClose} data-testid="backup-dialog">
      <div className="stack">
        <h2>Sicherung</h2>

        <section aria-label="Stand der Tagessicherung" data-testid="backup-state">
          {status && !status.enabled && <p className="muted">Auf dem Server ist keine Tagessicherung eingestellt.</p>}
          {status?.enabled && (
            <p>
              Tagessicherung: {status.lastAt === null ? "noch keine" : <>zuletzt <span className="num">{when(status.lastAt)}</span></>},
              die letzten <span className="num">{status.keep}</span> bleiben erhalten.
            </p>
          )}
          {status?.error && <p className="error" role="alert" data-testid="backup-failed">Die letzte Tagessicherung ist fehlgeschlagen: {status.error.message}</p>}
          {status && status.log.length > 0 && (
            <details>
              <summary>Auftragsprotokoll</summary>
              <ul className="venue-notes">
                {status.log.map((l) => <li key={`${l.at}-${l.text}`} className={l.ok ? "" : "error"}><span className="num">{when(l.at)}</span> {l.text}</li>)}
              </ul>
            </details>
          )}
        </section>

        <section aria-label="Gesamtsicherung">
          <h3>Gesamtsicherung</h3>
          <p className="muted">Eine Datei mit allen Simulationen, Depots, Orders, Journalnotizen und Depotwerten. Das Kursarchiv ist nicht dabei.</p>
          <a className="btn" href="/api/backup" download data-testid="backup-download">Sicherung herunterladen</a>
        </section>

        <section aria-label="Wiederherstellen">
          <h3>Wiederherstellen</h3>
          <p className="muted">Ersetzt alle Simulationen durch den Inhalt der Datei. Vorher wird der aktuelle Stand automatisch gesichert.</p>
          <input type="file" accept=".sqlite,.db,application/octet-stream" data-testid="restore-file" aria-label="Sicherungsdatei wählen"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setConfirming(false); }} />
          {file && !confirming && (
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(true)} data-testid="restore-start">Wiederherstellen …</button>
          )}
          {file && confirming && (
            <p role="alertdialog" className="banner" data-testid="restore-confirm">
              Alle jetzigen Simulationen werden durch die aus „{file.name}“ ersetzt. Fortfahren?{" "}
              <button type="button" className="btn" disabled={busy} onClick={() => void restore()} data-testid="restore-confirm-yes">Ja, ersetzen</button>{" "}
              <button type="button" className="btn" onClick={() => setConfirming(false)}>Abbrechen</button>
            </p>
          )}
        </section>

        <section aria-label="Eine Simulation">
          <h3>Eine Simulation</h3>
          {simulationId !== null ? (
            <p className="actions">
              <a className="btn" href={`/api/simulations/${simulationId}/export`} download data-testid="export-sim">Als JSON exportieren</a>
              <a className="btn" href={`/api/simulations/${simulationId}/orders.csv`} download data-testid="export-orders">Orders als CSV</a>
              <a className="btn" href={`/api/simulations/${simulationId}/values.csv`} download data-testid="export-values">Depotwerte als CSV</a>
            </p>
          ) : <p className="muted">Wähle eine Simulation, um sie zu exportieren.</p>}
          <label className="muted">Aus einer Exportdatei importieren (als neue Simulation):{" "}
            <input type="file" accept=".json,application/json" data-testid="import-file" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
          </label>
        </section>

        {message && <p role="status" data-testid="backup-message">{message}</p>}
        {error && <p className="error" role="alert" data-testid="backup-error">{error}</p>}

        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Schließen</button>
        </div>
      </div>
    </dialog>
  );
}
