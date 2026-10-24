import { useEffect, useRef, useState } from "react";
import type { DepotView } from "../types.js";

export const MAX_DEPOTS = 8;

interface Props {
  depots: DepotView[];
  activeId: number;
  disabled: boolean;
  onSelect: (id: number) => void;
  onAdd: () => void;
  onRename: (id: number, name: string) => void;
  onRemove: (id: number) => void;
  onAllocate: () => void;
}

/** The tabs of the depots, and a dialog to rename or delete the one that is shown. */
export function DepotSwitch({ depots, activeId, disabled, onSelect, onAdd, onRename, onRemove, onAllocate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const active = depots.find((d) => d.id === activeId) ?? depots[0];
  const [name, setName] = useState(active.name);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <section className="card" aria-label="Depots">
      <div className="depot-tabs" role="tablist" aria-label="Depots">
        {depots.map((d) => (
          <button key={d.id} role="tab" className="btn" aria-selected={d.id === active.id}
            onClick={() => onSelect(d.id)}>{d.name}</button>
        ))}
        <button className="btn small" disabled={disabled || depots.length >= MAX_DEPOTS} onClick={onAdd}>+ Depot</button>
      </div>
      <div className="group">
        <button className="btn small" disabled={disabled} onClick={onAllocate}>Aufbau nach Prozent</button>
        <button className="btn small" onClick={() => { setName(active.name); setOpen(true); }}>Depot verwalten</button>
      </div>

      <dialog ref={dialog} aria-label="Depot verwalten" onClose={() => setOpen(false)}>
        <form onSubmit={(e) => { e.preventDefault(); onRename(active.id, name.trim()); setOpen(false); }}>
          <label>Name
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setOpen(false)}>Abbrechen</button>
            <button type="submit" className="btn primary" disabled={name.trim() === ""}>Speichern</button>
          </div>
          <hr />
          <p className="muted">
            {depots.length === 1
              ? "Das letzte Depot lässt sich nicht löschen."
              : `Löscht ${active.name} mit ${active.positions.length} Positionen und ${active.orders.filter((o) => o.status === "open").length} offenen Aufträgen.`}
          </p>
          <button type="button" className="btn" disabled={depots.length === 1 || disabled}
            onClick={() => { onRemove(active.id); setOpen(false); }}>Depot löschen</button>
        </form>
      </dialog>
    </section>
  );
}
