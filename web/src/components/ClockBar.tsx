import { formatLag } from "../lag.js";
import { formatSimTime } from "../time.js";
import { PRESET_LABEL, describeRules } from "../rules.js";
import type { Rules, Snapshot, Tempo } from "../types.js";

const TEMPOS: Tempo[] = [1, 5, 30, 60];

interface Props {
  simulationTime: number;
  tempo: Tempo;
  running: boolean;
  disabled: boolean;
  /** A live simulation sets its own tempo. */
  live: boolean;
  phase: Snapshot["phase"];
  /** Seconds between the simulation time and the live limit. */
  lagS: number;
  delayS: number;
  rules: Rules;
  onTempo: (t: Tempo) => void;
  onRun: () => void;
  onPause: () => void;
}

export function ClockBar({ simulationTime, tempo, running, disabled, live, phase, lagS, delayS, rules, onTempo, onRun, onPause }: Props) {
  const status = live
    ? phase === "catchup"
      ? `Aufholen · noch ${formatLag(lagS)}`
      : `Live · Zeitversatz ${Math.round(delayS / 60)} Min.`
    : phase === "live"
      ? "Gegenwart erreicht"
      : null;
  return (
    <div className="clock">
      <div>
        <h2>Simulationszeit<span className="badge rules" data-testid="rules-badge" title={describeRules(rules)}>{PRESET_LABEL[rules.preset]}</span></h2>
        <div className="time num" data-testid="sim-time">{formatSimTime(simulationTime)}</div>
        {status && <div className={`status ${phase === "catchup" ? "" : "up"}`} data-testid="clock-status">{status}</div>}
      </div>
      {rules.tempoLocked ? <span className="muted" data-testid="tempo-locked">Tempo fest: {tempo}x</span> : (
      <div className="group" role="group" aria-label="Tempo">
        {TEMPOS.map((t, n) => (
          <button
            key={t} className="btn" aria-pressed={t === tempo} disabled={disabled || live} onClick={() => onTempo(t)}
            title={live ? "Im Livebetrieb bestimmt die Uhr das Tempo" : `Taste ${n + 1}`}
          >
            {t}x
          </button>
        ))}
      </div>
      )}
      {running ? (
        rules.pauseAllowed
          ? <button className="btn primary" disabled={disabled} onClick={onPause}>Pause</button>
          : <span className="muted" data-testid="no-pause">Die Uhr läuft, es gibt keine Pause.</span>
      ) : (
        <button className="btn primary" disabled={disabled} onClick={onRun}>Start</button>
      )}
    </div>
  );
}
