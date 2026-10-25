import { useEffect, useRef } from "react";

const KEYS: [string, string][] = [
  ["B", "Kaufen: Menge im Orderticket"],
  ["S", "Verkaufen: Menge im Orderticket"],
  ["G", "Kennzahlen erklärt (Glossar)"],
  ["Leertaste", "Start oder Pause"],
  [".", "Nächste Kerze (Tageskurse: ein Tag weiter)"],
  ["1 – 4", "Tempo 1x, 5x, 30x, 60x"],
  ["Strg + K", "Suche und Befehle (auf dem Mac Cmd + K)"],
  ["?", "Diese Liste"],
  ["H", "So wird gespielt (Anleitung)"],
  ["Esc", "Dialog schließen"],
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ShortcutHelp({ open, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={dialog} aria-label="Tastenkürzel" onClose={onClose}>
      <h2>Tastenkürzel</h2>
      <dl className="keys">
        {KEYS.map(([key, what]) => (
          <div key={key}><dt><kbd>{key}</kbd></dt><dd>{what}</dd></div>
        ))}
      </dl>
      <p className="muted">Die Buchstaben und Ziffern gelten nicht, solange du in ein Feld tippst.</p>
      <div className="actions"><button className="btn" onClick={onClose}>Schließen</button></div>
    </dialog>
  );
}
