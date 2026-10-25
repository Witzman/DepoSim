import { useEffect, useMemo, useRef, useState } from "react";
import { searchGlossary } from "../glossary.js";
import { EntryText } from "./Hint.js";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Filled into the search when the dialog opens (the "Warum?" of a hint). */
  initialQuery?: string;
}

export function Glossary({ open, onClose, initialQuery = "" }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery(initialQuery);
      d.showModal();
      input.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const entries = useMemo(() => searchGlossary(query), [query]);

  return (
    <dialog ref={dialog} className="glossary" data-testid="glossary" aria-label="Kennzahlen erklärt" onClose={onClose}>
      <h2>Kennzahlen erklärt</h2>
      <input ref={input} type="text" aria-label="Kennzahl suchen" placeholder="Kennzahl suchen …" data-testid="glossary-input"
        value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
      <p className="muted">Faustwerte sind Orientierung, keine Anlageberatung. Die Formeln entsprechen der Rechnung in DepoSim, auch wo sie vom Lehrbuch abweicht.</p>
      <div className="glossary-list">
        {entries.map((e) => (
          <section key={e.id} data-testid={`glossary-${e.id}`}>
            <h3>{e.name}</h3>
            <EntryText entry={e} />
          </section>
        ))}
        {entries.length === 0 && <p className="muted" role="status">Nichts gefunden.</p>}
      </div>
      <div className="actions"><button className="btn" onClick={onClose}>Schließen</button></div>
    </dialog>
  );
}
