import { useEffect, useRef, useState } from "react";
import { berlinToUtcSeconds, formatSimTime, lastTradingDay } from "../time.js";
import type { Simulation } from "../types.js";

interface Props {
  simulations: Simulation[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Resolves when the simulation exists; rejects with a message that is shown in the dialog. */
  onCreate: (input: { name: string; startAt?: number; live?: boolean }) => Promise<void>;
  onEnd: (id: number) => void;
  onDelete: (id: number) => void;
}

export function SimulationPicker({ simulations, selectedId, onSelect, onCreate, onEnd, onDelete }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState(() => lastTradingDay(new Date()));
  const [time, setTime] = useState("10:00");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let startAt: number | undefined;
    if (!live) {
      try {
        startAt = berlinToUtcSeconds(date, time);
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }
    setBusy(true);
    try {
      await onCreate({ name: name.trim() || `Simulation ${simulations.length + 1}`, ...(live ? { live: true } : { startAt }) });
      setOpen(false);
      setName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Simulationen">
      <div className="toolbar">
        <h2>Simulationen</h2>
        <button className="btn small primary" onClick={() => { setError(null); setOpen(true); }}>Neue Simulation</button>
      </div>

      {simulations.length === 0 ? (
        <p className="muted">Lege eine Simulation an, um zu beginnen.</p>
      ) : (
        <ul className="sim-list" data-testid="sim-list">
          {simulations.map((s) => (
            <li key={s.id} className="sim-item" aria-current={s.id === selectedId} onClick={() => onSelect(s.id)}>
              <div className="row"><strong>{s.name}{s.live && <span className="badge">Live</span>}</strong>{s.endedAt !== null && <span className="muted">beendet</span>}</div>
              <div className="muted num">{formatSimTime(s.simulationTime)}</div>
              <div className="row">
                {s.endedAt === null ? (
                  <button className="btn small" onClick={(e) => { e.stopPropagation(); if (confirm(`„${s.name}“ beenden?`)) onEnd(s.id); }}>Beenden</button>
                ) : <span />}
                <button className="btn small" onClick={(e) => { e.stopPropagation(); if (confirm(`„${s.name}“ endgültig löschen?`)) onDelete(s.id); }}>Löschen</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <dialog ref={dialog} onClose={() => setOpen(false)}>
        <form onSubmit={submit}>
          <h1>Neue Simulation</h1>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Simulation ${simulations.length + 1}`} /></label>
          <label className="check">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            <span>Live (folgt der Echtzeit mit Zeitversatz)</span>
          </label>
          {live ? (
            <p className="muted">Startet ab jetzt, bei geschlossenem Markt am Ende des letzten Handelstags. Nach einer Pause holt die Simulation von selbst auf.</p>
          ) : null}
          <label>Datum<input type="date" required={!live} disabled={live} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Uhrzeit (Berliner Zeit)<input type="time" required={!live} disabled={live} value={time} onChange={(e) => setTime(e.target.value)} /></label>
          <p className="muted">Die Kurse dieses Handelstags werden geladen. Das kann ein paar Sekunden dauern.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? "Kurse werden geladen …" : "Anlegen"}</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
