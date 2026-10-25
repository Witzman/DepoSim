import { useEffect, useRef, useState } from "react";
import { berlinToUtcSeconds, formatSimTime, lastTradingDay } from "../time.js";
import { PRESET_LABEL, PRESET_TEXT } from "../rules.js";
import { getScenarios } from "../api.js";
import { bestStars, starText } from "../scenarioStars.js";
import type { Rules, Scenario, Simulation } from "../types.js";

interface Props {
  simulations: Simulation[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Resolves when the simulation exists; rejects with a message that is shown in the dialog. */
  onCreate: (input: { name: string; startAt?: number; live?: boolean; resolution?: "minute" | "day"; scenarioId?: string; preset?: "relaxed" | "realistic" | "hardcore"; rules?: Partial<Omit<Rules, "preset">> }) => Promise<void>;
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
  const [byDay, setByDay] = useState(false);
  const [preset, setPreset] = useState<"relaxed" | "realistic" | "hardcore">("relaxed");
  const [maxPositions, setMaxPositions] = useState("");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open || scenarios.length > 0) return;
    // Without scenarios the dialog is the free game it always was.
    getScenarios().then(setScenarios).catch(() => {});
  }, [open, scenarios.length]);

  const scenario = scenarios.find((s) => s.id === scenarioId) ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (scenario) {
      setBusy(true);
      try {
        await onCreate({ name: name.trim() || scenario.title, scenarioId: scenario.id });
        setOpen(false);
        setName("");
        setScenarioId(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    let startAt: number | undefined;
    if (!live) {
      try {
        startAt = berlinToUtcSeconds(date, byDay ? "12:00" : time);
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }
    setBusy(true);
    try {
      await onCreate({ name: name.trim() || `Simulation ${simulations.length + 1}`, ...(live ? { live: true } : { startAt }), ...(byDay ? { resolution: "day" as const } : {}), preset, ...(maxPositions.trim() !== "" ? { rules: { maxPositions: Number(maxPositions) } } : {}) });
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
        <button className="btn small primary" data-guide="new-sim" onClick={() => { setError(null); setOpen(true); }}>Neue Simulation</button>
      </div>

      {simulations.length === 0 ? (
        <p className="muted">Lege eine Simulation an, um zu beginnen.</p>
      ) : (
        <ul className="sim-list" data-testid="sim-list">
          {simulations.map((s) => (
            <li key={s.id} className="sim-item" aria-current={s.id === selectedId} onClick={() => onSelect(s.id)}>
              <div className="row"><strong>{s.name}{s.live && <span className="badge">Live</span>}</strong>{s.endedAt !== null && <span className="muted">beendet</span>}</div>
              <div className="muted num">{formatSimTime(s.simulationTime, s.resolution === "day")} · {s.resolution === "day" ? "Tageskurse · " : ""}{PRESET_LABEL[s.rules.preset]}</div>
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
          {scenarios.length > 0 && (
            <fieldset className="scenarios" data-testid="scenario-picker">
              <legend>Spielart</legend>
              <label className="check">
                <input type="radio" name="scenario" checked={scenario === null} onChange={() => setScenarioId(null)} />
                <span><strong>Freies Spiel</strong> <span className="muted">eigener Zeitpunkt, kein Ziel</span></span>
              </label>
              {scenarios.map((sc) => (
                <label key={sc.id} className="check scenario-card" data-testid={`scenario-${sc.id}`}>
                  <input type="radio" name="scenario" checked={scenarioId === sc.id} onChange={() => setScenarioId(sc.id)} />
                  <span>
                    <strong>{sc.title}</strong> <span className="badge">{sc.difficulty}</span>{" "}
                    <span className="muted num">{formatSimTime(sc.startAt, true)} bis {formatSimTime(sc.endAt, true)}</span>{" "}
                    <span className="stars" aria-label={`Beste Wertung: ${bestStars(sc.id)} von 3 Sternen`}>{starText(bestStars(sc.id))}</span>
                    {scenarioId === sc.id && <span className="muted scenario-story">{sc.story}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={scenario ? scenario.title : `Simulation ${simulations.length + 1}`} /></label>
          {scenario ? null : <>
          <label className="check">
            <input type="checkbox" checked={byDay} disabled={live} data-testid="by-day"
              onChange={(e) => { setByDay(e.target.checked); if (e.target.checked) setDate("2020-02-03"); }} />
            <span>Tageskurse: ein Schritt ist ein Handelstag, ab November 2019 möglich</span>
          </label>
          {byDay && <p className="muted">Orders werden zum Eröffnungskurs des nächsten Handelstags ausgeführt; Limit-Orders nur, wenn der Tag das Limit klar überschreitet. Das ist eine grobe Näherung ohne Minutenverlauf.</p>}
          <label className="check">
            <input type="checkbox" checked={live} disabled={byDay} onChange={(e) => setLive(e.target.checked)} />
            <span>Live (folgt der Echtzeit mit Zeitversatz)</span>
          </label>
          {live ? (
            <p className="muted">Startet ab jetzt, bei geschlossenem Markt am Ende des letzten Handelstags. Nach einer Pause holt die Simulation von selbst auf.</p>
          ) : null}
          <fieldset className="rules" data-testid="rules-picker">
            <legend>Spielregeln</legend>
            {(["relaxed", "realistic", "hardcore"] as const).map((p) => (
              <label key={p} className="check">
                <input type="radio" name="preset" value={p} checked={preset === p} onChange={() => setPreset(p)} />
                <span><strong>{PRESET_LABEL[p]}</strong> <span className="muted">{PRESET_TEXT[p]}</span></span>
              </label>
            ))}
            {preset === "hardcore" && <p className="muted" role="note">Achtung: Ohne Pause läuft die Zeit auch bei Tempo 1 weiter. Die Regeln lassen sich später nicht ändern.</p>}
            <label>Höchstens so viele verschiedene Positionen (leer: unbegrenzt)
              <input type="number" min={1} max={50} inputMode="numeric" value={maxPositions} onChange={(e) => setMaxPositions(e.target.value)} />
            </label>
          </fieldset>
          <label>Datum<input type="date" required={!live} disabled={live} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Uhrzeit (Berliner Zeit)<input type="time" required={!live && !byDay} disabled={live || byDay} value={time} onChange={(e) => setTime(e.target.value)} /></label>
          </>}
          <p className="muted">{scenario ? "Die Kurse des Zeitraums werden geladen. Das kann ein paar Sekunden dauern." : "Die Kurse dieses Handelstags werden geladen. Das kann ein paar Sekunden dauern."}</p>
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
