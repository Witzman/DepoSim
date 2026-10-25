import { useEffect, useId, useRef, useState } from "react";
import { type Entry, entryOf } from "../glossary.js";

/** The text of one glossary entry; shared by the popover and the glossary dialog. */
export function EntryText({ entry }: { entry: Entry }) {
  return (
    <>
      <p>{entry.short}</p>
      <p><strong>So entsteht sie: </strong>{entry.how}</p>
      {entry.rule && <p><strong>Faustwert: </strong>{entry.rule} <span className="muted">Orientierung, keine Empfehlung.</span></p>}
      {entry.pitfall && <p><strong>Vorsicht: </strong>{entry.pitfall}</p>}
    </>
  );
}

/**
 * An info button after a figure's name. The text opens on click or Enter/Space and closes on Esc, a
 * click elsewhere or the button again, so it works without hover (phones). Focus stays on the button;
 * the text is tied to it by `aria-describedby`.
 */
export function Hint({ id }: { id: string }) {
  const entry = entryOf(id);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (!entry) return null;
  return (
    <span className="hint" ref={root}>
      <button type="button" className="hint-btn" data-testid={`hint-${id}`} aria-expanded={open} aria-describedby={open ? popId : undefined}
        aria-label={`Erklärung: ${entry.name}`} onClick={() => setOpen((o) => !o)}>i</button>
      {open && (
        <span className="hint-pop" id={popId} role="note" data-testid={`hint-text-${id}`}>
          <strong>{entry.name}</strong>
          <EntryText entry={entry} />
        </span>
      )}
    </span>
  );
}
