import { useEffect, useRef, useState } from "react";
import { MAX_TEXT } from "../drawings.js";

export type Tool = "hline" | "trend" | "marker" | "delete";

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: "hline", label: "Waagerechte Linie", hint: "Ein Klick setzt die Linie." },
  { id: "trend", label: "Trendlinie", hint: "Zwei Klicks: Anfang und Ende." },
  { id: "marker", label: "Markierung", hint: "Klick auf eine Stelle, dann den Text eingeben." },
  { id: "delete", label: "Löschen", hint: "Klick in die Nähe einer Zeichnung entfernt sie." },
];

interface Props {
  tool: Tool | null;
  trendStarted: boolean;
  /** True while a marker waits for its text. */
  markerPending: boolean;
  count: number;
  onTool: (t: Tool | null) => void;
  onMarkerText: (text: string | null) => void;
  onClear: () => void;
}

export function DrawTools({ tool, trendStarted, markerPending, count, onTool, onMarkerText, onClear }: Props) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (markerPending) { setText(""); input.current?.focus(); }
  }, [markerPending]);

  const active = TOOLS.find((t) => t.id === tool);
  return (
    <div className="draw-tools" data-guide="draw">
      <div role="group" aria-label="Zeichenwerkzeuge" className="draw-buttons">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" className="btn small" aria-pressed={tool === t.id} title={t.hint}
            onClick={() => onTool(tool === t.id ? null : t.id)}>{t.label}</button>
        ))}
        <button type="button" className="btn small" disabled={count === 0} onClick={onClear}>Alle löschen</button>
      </div>
      {markerPending && (
        <form className="draw-text" onSubmit={(e) => { e.preventDefault(); onMarkerText(text); }}>
          <input ref={input} aria-label="Text der Markierung" maxLength={MAX_TEXT} value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onMarkerText(null); } }} />
          <button type="submit" className="btn primary" disabled={text.trim() === ""}>Setzen</button>
        </form>
      )}
      {active && !markerPending && (
        <span className="muted draw-hint" role="status">
          {active.id === "trend" && trendStarted ? "Zweiter Klick setzt das Ende." : active.hint} Esc bricht ab.
        </span>
      )}
    </div>
  );
}
