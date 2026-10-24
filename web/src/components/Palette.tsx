import { useEffect, useMemo, useRef, useState } from "react";
import { searchInstruments } from "../api.js";
import { type Entry, buildEntries } from "../palette.js";
import type { Instrument, SearchHit, Simulation } from "../types.js";

interface Props {
  open: boolean;
  instruments: Instrument[];
  simulations: Simulation[];
  selectedId: number | null;
  onClose: () => void;
  onPickInstrument: (symbol: string) => void;
  onPickSimulation: (id: number) => void;
  onToggleTheme: () => void;
  onShowHelp: () => void;
  /** Resolves when the instrument is in the list; rejects with a message that is shown here. */
  onAdd: (symbol: string) => Promise<void>;
}

const SEARCH_WAIT_MS = 250;
const MIN_QUERY = 2;
const PLACE = { XETRA: "Xetra", US: "US-Börse" } as const;

function describe(e: Entry, selectedId: number | null): { text: string; tag: string } {
  switch (e.kind) {
    case "instrument":
      return { text: `${e.instrument.symbol} · ${e.instrument.name}`, tag: "Wertpapier" };
    case "simulation":
      return { text: e.simulation.name + (e.simulation.id === selectedId ? " (offen)" : ""), tag: "Simulation" };
    case "theme":
      return { text: "Hell oder Dunkel umschalten", tag: "Ansicht" };
    case "help":
      return { text: "Tastenkürzel anzeigen", tag: "Hilfe" };
    case "hit":
      return { text: `${e.hit.symbol} · ${e.hit.name} (${PLACE[e.hit.venue]})`, tag: "Neu hinzufügen" };
  }
}

export function Palette({
  open, instruments, simulations, selectedId, onClose, onPickInstrument, onPickSimulation, onToggleTheme, onShowHelp, onAdd,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery("");
      setHits([]);
      setProblem(null);
      setActive(0);
      d.showModal();
      input.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // The search waits until typing pauses and never answers for an old query.
  useEffect(() => {
    const q = query.trim();
    setHits([]);
    if (!open || q.length < MIN_QUERY) {
      setProblem(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      searchInstruments(q)
        .then((found) => { if (current) { setHits(found); setProblem(null); } })
        .catch((e: Error) => { if (current) setProblem(e.message); });
    }, SEARCH_WAIT_MS);
    return () => { current = false; clearTimeout(timer); };
  }, [query, open]);

  const entries = useMemo(() => buildEntries(query, instruments, simulations, hits), [query, instruments, simulations, hits]);
  useEffect(() => setActive(0), [entries.length, query]);

  async function pick(e: Entry | undefined) {
    if (!e || busy) return;
    if (e.kind === "instrument") onPickInstrument(e.instrument.symbol);
    else if (e.kind === "simulation") onPickSimulation(e.simulation.id);
    else if (e.kind === "theme") onToggleTheme();
    else if (e.kind === "help") onShowHelp();
    else {
      setBusy(true);
      setProblem(null);
      try {
        await onAdd(e.hit.symbol);
      } catch (err) {
        setProblem((err as Error).message);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    onClose();
  }

  function onKeyDown(ev: React.KeyboardEvent) {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(entries.length - 1, 0)));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      void pick(entries[active]);
    }
  }

  return (
    <dialog ref={dialog} className="palette" data-testid="palette" aria-label="Befehlspalette" onClose={onClose}>
      <input
        ref={input} data-testid="palette-input" type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
        aria-activedescendant={entries.length > 0 ? `palette-option-${Math.min(active, entries.length - 1)}` : undefined}
        aria-label="Suche und Befehle" placeholder="Wertpapier suchen oder Befehl …"
        value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} autoComplete="off" spellCheck={false}
      />
      <ul id="palette-list" role="listbox" aria-label="Treffer">
        {entries.map((e, n) => {
          const { text, tag } = describe(e, selectedId);
          return (
            <li key={n} id={`palette-option-${n}`} role="option" aria-selected={n === active} onMouseEnter={() => setActive(n)} onClick={() => void pick(e)}>
              <span>{text}</span>
              <span className="muted">{tag}</span>
            </li>
          );
        })}
      </ul>
      {problem && <p className="error" role="status">{problem}</p>}
      {!problem && entries.length === 0 && <p className="muted" role="status">Nichts gefunden.</p>}
    </dialog>
  );
}
