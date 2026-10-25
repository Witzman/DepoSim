import { backupLine } from "../backup.js";
import { lightLine } from "../data.js";
import type { Theme } from "../theme.js";
import type { BackupStatus, DataStatus, Simulation } from "../types.js";

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
  /** The open simulation, if any. */
  live: Simulation | null;
  running: boolean;
  narrow: boolean;
  dataState: DataStatus | null;
  backupState: BackupStatus | null;
  /** The hints button shows only with a depot open. */
  hasDepot: boolean;
  hintCount: number;
  onData: () => void;
  onBackup: () => void;
  onHints: () => void;
  onFeedback: () => void;
  onPalette: () => void;
}

/** The bar at the top: name, state of the clock, the lights of data and backup, and the buttons that open the dialogs. */
export function TopBar({ theme, onToggleTheme, live, running, narrow, dataState, backupState, hasDepot, hintCount, onData, onBackup, onHints, onFeedback, onPalette }: Props) {
  return (
  <header className="topbar">
    <h1 className="brand">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="var(--accent)" />
        <path d="M6 22 L12 15 L17 19 L22 11 L26 9" fill="none" stroke="var(--accent-text)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      DepoSim
    </h1>
    {live && (
      <span className={`pill${running ? " on" : ""}`} data-testid="top-status">
        <span className="dot" aria-hidden="true" />
        {live.endedAt !== null ? "beendet" : running ? "läuft" : "angehalten"}
      </span>
    )}
    <span className="spacer" />
    {dataState && (() => {
      const line = lightLine(dataState);
      return (
        <button className={`btn small light-btn ${dataState.level}`} data-testid="data-status" data-level={dataState.level}
          onClick={onData} title={line.title} aria-label={`${line.text}. Datenzustand öffnen`}>
          <span className={`light ${dataState.level}`} aria-hidden="true" />{narrow ? "" : line.text}
        </button>
      );
    })()}
    {backupState && (() => {
      // On a phone the bar has no room: the line shows only when something is wrong; the palette opens the dialog.
      const line = backupLine(backupState, Date.now() / 1000);
      if (narrow && !line.bad) return null;
      return (
        <button className={`btn small${line.bad ? " error" : ""}`} data-testid="backup-status" onClick={onBackup}
          title={line.text}>{narrow ? (line.bad ? "Sicherung !" : "Sicherung") : line.text}</button>
      );
    })()}
    {live && hasDepot && (
      <button className="btn small" data-testid="hints-open" onClick={onHints}
        aria-label={`Hinweise: ${hintCount}`} title="Hinweise und Einstellungen">Hinweise{hintCount > 0 && <span className="badge warn" data-testid="hints-count">{hintCount}</span>}</button>
    )}
    <button className="btn small" data-testid="feedback-open" onClick={onFeedback} aria-label="Rückmeldung einstellen" title="Ton, Vibration, Bewegung">Ton</button>
    <button className="btn small" data-testid="palette-open" onClick={onPalette}
      aria-label="Suche und Befehle öffnen (Strg+K)" title="Strg+K">Suche</button>
    <button className="btn small" data-testid="theme-toggle" onClick={onToggleTheme} aria-label="Hell oder Dunkel umschalten">
      {theme === "dark" ? "Hell" : "Dunkel"}
    </button>
  </header>
  );
}
