import { useEffect, useState } from "react";
import { formatLag } from "../lag.js";
import { formatSimTime } from "../time.js";
import { PRESET_LABEL, describeRules } from "../rules.js";
import type { AutoPause, JumpKind, Rules, Snapshot, Tempo } from "../types.js";

const TEMPOS: Tempo[] = [1, 5, 30, 60];
/** Time lapse: only while no order is open, in a replay of minute prices. */
const TIME_LAPSE: Tempo[] = [120, 300];

const JUMPS: { kind: JumpKind; label: string; title: string }[] = [
  { kind: "candle", label: "Nächste Kerze", title: "Taste . (Punkt)" },
  { kind: "hour", label: "+1 Std.", title: "Eine Stunde weiter" },
  { kind: "close", label: "Bis Handelsschluss", title: "Bis zum nächsten Schluss des Marktes des gezeigten Titels" },
  { kind: "open", label: "Bis Eröffnung", title: "Bis zur nächsten Eröffnung des Marktes des gezeigten Titels" },
  { kind: "day", label: "Bis nächster Tag", title: "Bis Mitternacht am Ort des Marktes" },
];

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
  /** A daily simulation: the tempo is days per second, "Tag weiter" plays one day, and `skipped` days had no price. */
  daily?: { skipped: number; onStep: () => void };
  /** Jumps to a time; absent where there are none (live, ended, a daily simulation, no pause allowed). */
  onJump?: (kind: JumpKind) => void;
  /** Time lapse needs no open order. */
  hasOpenOrders?: boolean;
  /** The rules that stop the clock by themselves; absent where a stop makes no sense. */
  autoPause?: { value: AutoPause; daily: boolean; onChange: (patch: Partial<AutoPause>) => void | Promise<void> };
  onTempo: (t: Tempo) => void;
  onRun: () => void;
  onPause: () => void;
}

/** The switches of the auto-pause. They change at once on the page and are sent to the server in the background. */
function AutoPauseMenu({ value, daily, onChange }: { value: AutoPause; daily: boolean; onChange: (patch: Partial<AutoPause>) => void | Promise<void> }) {
  const [ap, setAp] = useState(value);
  useEffect(() => setAp(value), [value]);
  const change = (patch: Partial<AutoPause>) => {
    setAp((prev) => ({ ...prev, ...patch }));
    // A refusal (409 in a game without pause) must not leave a switch on that the server did not take.
    void Promise.resolve(onChange(patch)).catch(() => setAp(value));
  };
  return (
        <details className="autopause" data-testid="autopause">
          <summary>Auto-Pause{ap.onFill || ap.nearLimit || ap.jump || ap.onOpen || ap.onEvent ? " (an)" : ""}</summary>
          <div className="autopause-body">
            <p className="muted">Die Uhr hält von selbst an und sagt warum. Jede Ursache meldet sich einmal.</p>
            <label className="check"><input type="checkbox" checked={ap.onFill} onChange={(e) => change({ onFill: e.target.checked })} /><span>Bei Orderausführung</span></label>
            <label className="check"><input type="checkbox" checked={ap.nearLimit} onChange={(e) => change({ nearLimit: e.target.checked })} />
              <span>Wenn der Kurs nah am Limit einer Order liegt (innerhalb von{" "}
                <input type="number" min={0.05} max={10} step={0.05} className="mini" aria-label="Abstand zum Limit in Prozent" value={Number((ap.nearLimitPct * 100).toFixed(2))}
                  onChange={(e) => { const v = Number(e.target.value); if (v > 0) change({ nearLimitPct: v / 100 }); }} /> %)</span></label>
            {!daily && (
              <label className="check"><input type="checkbox" checked={ap.jump} onChange={(e) => change({ jump: e.target.checked })} />
                <span>Bei Kurssprung von{" "}
                  <input type="number" min={0.5} max={50} step={0.5} className="mini" aria-label="Kurssprung in Prozent" value={Number((ap.jumpPct * 100).toFixed(2))}
                    onChange={(e) => { const v = Number(e.target.value); if (v > 0) change({ jumpPct: v / 100 }); }} /> % in{" "}
                  <input type="number" min={1} max={240} step={1} className="mini" aria-label="Minuten für den Kurssprung" value={ap.jumpMinutes}
                    onChange={(e) => { const v = Math.round(Number(e.target.value)); if (v > 0) change({ jumpMinutes: v }); }} /> Minuten (gehaltene Titel)</span></label>
            )}
            {!daily && <label className="check"><input type="checkbox" checked={ap.onOpen} onChange={(e) => change({ onOpen: e.target.checked })} /><span>Bei Marktöffnung</span></label>}
            <label className="check"><input type="checkbox" checked={ap.onEvent} onChange={(e) => change({ onEvent: e.target.checked })} /><span>Bei Dividende oder Split</span></label>
          </div>
        </details>
  );
}

export function ClockBar({ simulationTime, tempo, running, disabled, live, phase, lagS, delayS, rules, daily, onJump, hasOpenOrders, autoPause, onTempo, onRun, onPause }: Props) {
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
        <div className="time num" data-testid="sim-time">{formatSimTime(simulationTime, daily !== undefined)}</div>
        {daily && <div className="status" data-testid="daily-note">Tageskurse, ein Schritt ist ein Handelstag{daily.skipped > 0 && ` · ${daily.skipped} Handelstage ohne Kurs übersprungen`}</div>}
        {status && <div className={`status ${phase === "catchup" ? "" : "up"}`} data-testid="clock-status">{status}</div>}
      </div>
      {rules.tempoLocked ? <span className="muted" data-testid="tempo-locked">Tempo fest: {tempo}x</span> : (
      <div className="group" role="group" aria-label="Tempo">
        {TEMPOS.map((t, n) => (
          <button
            key={t} className="btn" aria-pressed={t === tempo} disabled={disabled || live} onClick={() => onTempo(t)}
            title={live ? "Im Livebetrieb bestimmt die Uhr das Tempo" : `Taste ${n + 1}`}
          >
            {daily ? `${t} T/s` : `${t}x`}
          </button>
        ))}
        {!daily && !live && TIME_LAPSE.map((t) => (
          <button
            key={t} className="btn lapse" aria-pressed={t === tempo} data-testid={`lapse-${t}`}
            disabled={disabled || (hasOpenOrders === true && t !== tempo)} onClick={() => onTempo(t)}
            title={hasOpenOrders ? "Zeitraffer geht nur ohne offene Orders" : "Zeitraffer: Orders würden übersprungen, deshalb nur ohne offene Orders"}
          >
            {t}x
          </button>
        ))}
      </div>
      )}
      {onJump && (
        <div className="group jumps" role="group" aria-label="Sprung" data-testid="jumps">
          {JUMPS.map((j) => (
            <button key={j.kind} className="btn" disabled={disabled} title={j.title} data-testid={`jump-${j.kind}`} onClick={() => onJump(j.kind)}>{j.label}</button>
          ))}
        </div>
      )}
      {autoPause && <AutoPauseMenu value={autoPause.value} daily={autoPause.daily} onChange={autoPause.onChange} />}
      {daily && !running && <button className="btn" disabled={disabled} onClick={daily.onStep} data-testid="day-step">Tag weiter</button>}
      {running ? (
        rules.pauseAllowed
          ? <button className="btn primary" disabled={disabled} onClick={onPause}>Pause</button>
          : <span className="muted" data-testid="no-pause">Die Uhr läuft, es gibt keine Pause.</span>
      ) : (
        <button className="btn primary" data-guide="start" disabled={disabled} onClick={onRun}>Start</button>
      )}
    </div>
  );
}
