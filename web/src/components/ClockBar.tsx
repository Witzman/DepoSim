import { formatLag } from "../lag.js";
import { formatSimTime } from "../time.js";
import type { Snapshot, Tempo } from "../types.js";

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
  onTempo: (t: Tempo) => void;
  onRun: () => void;
  onPause: () => void;
}

export function ClockBar({ simulationTime, tempo, running, disabled, live, phase, lagS, delayS, onTempo, onRun, onPause }: Props) {
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
        <h2>Simulationszeit</h2>
        <div className="time num" data-testid="sim-time">{formatSimTime(simulationTime)}</div>
        {status && <div className={`status ${phase === "catchup" ? "" : "up"}`} data-testid="clock-status">{status}</div>}
      </div>
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
      {running ? (
        <button className="btn primary" disabled={disabled} onClick={onPause}>Pause</button>
      ) : (
        <button className="btn primary" disabled={disabled} onClick={onRun}>Start</button>
      )}
    </div>
  );
}
