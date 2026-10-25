import { useEffect, useRef, useState } from "react";
import { getResult } from "../api.js";
import { rememberStars, starText } from "../scenarioStars.js";
import type { ScenarioResult } from "../types.js";

/** How often the goals are looked at while the clock runs; the evaluation is not free. */
const REFRESH_MS = 4000;

/** The result of the scenario of a simulation, kept fresh while it runs. Null for a free game or while loading. */
export function useScenarioResult(simulationId: number, active: boolean, running: boolean, ended: boolean): ScenarioResult | null {
  const [result, setResult] = useState<ScenarioResult | null>(null);
  useEffect(() => {
    if (!active) { setResult(null); return; }
    let alive = true;
    const load = () => getResult(simulationId).then((r) => { if (alive) setResult(r); }).catch(() => {});
    load();
    const timer = running && !ended ? setInterval(load, REFRESH_MS) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [simulationId, active, running, ended]);
  return result;
}

function GoalList({ result }: { result: ScenarioResult }) {
  return (
    <ul className="goal-list" data-testid="goal-list">
      {result.goals.map((g) => (
        <li key={`${g.role}-${g.kind}`} data-met={g.met}>
          <span aria-hidden="true">{g.met ? "✓" : result.finished ? "✗" : "○"}</span>{" "}
          <span>{g.role === "bonus" ? "Bonus: " : ""}{g.label}</span>{" "}
          <span className="muted num">{g.actual}</span>
          <span className="sr-only">{g.met ? " erfüllt" : result.finished ? " verfehlt" : " noch nicht erfüllt"}</span>
        </li>
      ))}
    </ul>
  );
}

/** The goals under the clock: where the depot stands now, with the stars it would earn. */
export function ScenarioGoals({ result, onShowResult }: { result: ScenarioResult; onShowResult: () => void }) {
  return (
    <section className="card scenario-goals" aria-label="Ziele" data-testid="scenario-goals">
      <div className="toolbar">
        <h2>{result.title}</h2>
        <span className="stars" data-testid="goal-stars" aria-label={`${result.stars} von 3 Sternen`}>{starText(result.stars)}</span>
        {result.finished && <button className="btn small" onClick={onShowResult}>Ergebnis</button>}
      </div>
      <GoalList result={result} />
      {!result.finished && <p className="muted">Zwischenstand: so stünde das Depot jetzt da.</p>}
    </section>
  );
}

/** Opens by itself when `open` turns true; the stars are remembered once, when the scenario is over. */
export function ScenarioResultDialog({ result, open, onClose }: { result: ScenarioResult | null; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && result && !d.open) d.showModal();
    if ((!open || !result) && d.open) d.close();
  }, [open, result]);
  useEffect(() => {
    if (result?.finished) rememberStars(result.scenarioId, result.stars);
  }, [result?.finished, result?.scenarioId, result?.stars]);
  return (
    <dialog ref={dialog} onClose={onClose} data-testid="scenario-result">
      {result && (
        <div>
          <h1>{result.title}</h1>
          <p className="stars big" data-testid="result-stars" aria-label={`${result.stars} von 3 Sternen`}>{starText(result.stars)}</p>
          <p>{result.stars === 0 ? "Das Hauptziel wurde verfehlt." : result.stars === 3 ? "Hauptziel und beide Bonusziele erreicht." : "Das Hauptziel ist erreicht."}</p>
          <GoalList result={result} />
          <div className="actions"><button className="btn primary" onClick={onClose}>Schließen</button></div>
        </div>
      )}
    </dialog>
  );
}
