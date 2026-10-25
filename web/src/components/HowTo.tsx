import { useEffect, useMemo, useRef, useState } from "react";
import { chapterOf, searchHowto } from "../howto.js";
import { entryOf } from "../glossary.js";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The chapter to scroll to when the dialog opens (the "Mehr dazu" of a panel). */
  chapter?: string;
  /** Opens the glossary at an entry; the manual stays underneath. */
  onGlossary: (query: string) => void;
}

/** The manual (#57). A modal dialog changes nothing in the game: the clock keeps running underneath. */
export function HowTo({ open, onClose, chapter, onGlossary }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery("");
      d.showModal();
      const target = chapter && chapterOf(chapter) ? d.querySelector<HTMLElement>(`[data-testid="howto-${chapter}"]`) : null;
      if (target) target.scrollIntoView({ block: "start" });
      else input.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open, chapter]);

  const chapters = useMemo(() => searchHowto(query), [query]);

  return (
    <dialog ref={dialog} className="howto" data-testid="howto" aria-label="So wird gespielt" onClose={onClose}>
      <h2>So wird gespielt</h2>
      <input ref={input} type="text" aria-label="Anleitung durchsuchen" placeholder="Anleitung durchsuchen …" data-testid="howto-input"
        value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
      {open && query.trim() === "" && (
        <nav aria-label="Kapitel" className="howto-toc">
          {chapters.map((c, n) => (
            <a key={c.id} href={`#howto-${c.id}`} data-testid={`howto-toc-${c.id}`}
              onClick={(e) => { e.preventDefault(); dialog.current?.querySelector(`[data-testid="howto-${c.id}"]`)?.scrollIntoView({ block: "start" }); }}>{n + 1}. {c.title}</a>
          ))}
        </nav>
      )}
      <p className="muted">Spielgeld und Übung, keine Anlageberatung. Die Zahlen der Beispiele sind mit der Rechnung in DepoSim nachgerechnet.</p>
      <div className="howto-list">
        {/* Only while open: the text of a closed dialog is in the page and answers getByText of other specs. */}
        {open && chapters.map((c) => (
          <section key={c.id} data-testid={`howto-${c.id}`} aria-labelledby={`howto-h-${c.id}`}>
            <h3 id={`howto-h-${c.id}`}>{c.title}</h3>
            {c.body.map((p, i) => <p key={i}>{p}</p>)}
            {c.examples.map((e) => (
              <div key={e.id} className="howto-example" data-testid={`howto-example-${e.id}`}>
                <strong>Beispiel: {e.title}</strong>
                <p>{e.text}</p>
              </div>
            ))}
            {c.see && (
              <p className="muted">Erklärt in „Kennzahlen“: {c.see.map((id, i) => {
                const entry = entryOf(id);
                return entry ? <span key={id}>{i > 0 && ", "}<button className="link" onClick={() => onGlossary(entry.name)}>{entry.name}</button></span> : null;
              })}</p>
            )}
          </section>
        ))}
        {open && chapters.length === 0 && <p className="muted" role="status">Nichts gefunden.</p>}
      </div>
      <div className="actions"><button className="btn" onClick={onClose}>Schließen</button></div>
    </dialog>
  );
}
