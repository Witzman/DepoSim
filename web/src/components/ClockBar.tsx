import { formatSimTime } from "../time.js";
import type { Tempo } from "../types.js";

const TEMPOS: Tempo[] = [1, 5, 30, 60];

interface Props {
  simulationTime: number;
  tempo: Tempo;
  running: boolean;
  disabled: boolean;
  onTempo: (t: Tempo) => void;
  onRun: () => void;
  onPause: () => void;
}

export function ClockBar({ simulationTime, tempo, running, disabled, onTempo, onRun, onPause }: Props) {
  return (
    <div className="clock">
      <div>
        <h2>Simulationszeit</h2>
        <div className="time num" data-testid="sim-time">{formatSimTime(simulationTime)}</div>
      </div>
      <div className="group" role="group" aria-label="Tempo">
        {TEMPOS.map((t) => (
          <button key={t} className="btn" aria-pressed={t === tempo} disabled={disabled} onClick={() => onTempo(t)}>
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
