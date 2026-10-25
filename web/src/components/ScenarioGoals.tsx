import { useEffect, useState } from "react";
import { getResult } from "../api.js";
import { starText } from "../scenarioStars.js";
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

export function GoalList({ result }: { result: ScenarioResult }) {
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
