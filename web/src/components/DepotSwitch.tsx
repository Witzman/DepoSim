import { useEffect, useRef, useState } from "react";
import { tabKeys } from "../tabKeys.js";
import { canGhost } from "../view.js";
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
  onGhost: () => void;
}

/** The tabs of the depots, and a dialog to rename or delete the one that is shown. */
export function DepotSwitch({ depots, activeId, disabled, onSelect, onAdd, onRename, onRemove, onAllocate, onGhost }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const active = depots.find((d) => d.id === activeId) ?? depots[0];
  const ghost = active.kind === "ghost";
  const ghostCheck = canGhost(active);
  const normals = depots.filter((d) => d.kind === "normal").length;
  const lastNormal = !ghost && normals <= 1;
  const [name, setName] = useState(active.name);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <section className="card" aria-label="Depots">
      <div className="depot-tabs" role="tablist" aria-label="Depots" onKeyDown={tabKeys}>
        {depots.map((d) => (
          <button key={d.id} role="tab" className="btn" aria-selected={d.id === active.id} tabIndex={d.id === active.id ? 0 : -1}
            onClick={() => onSelect(d.id)}>{d.kind === "ghost" && <span aria-hidden="true">◌ </span>}{d.name}{d.kind === "ghost" && <span className="badge ghost">Geist</span>}</button>
        ))}
        <button className="btn small" disabled={disabled || depots.length >= MAX_DEPOTS} onClick={onAdd}>+ Depot</button>
      </div>
      <div className="group">
        <button className="btn small" disabled={disabled || ghost} onClick={onAllocate}
          title={ghost ? "Ein Geisterdepot handelt nicht." : undefined}>Aufbau nach Prozent</button>
        <button className="btn small" disabled={disabled || !ghostCheck.ok || depots.length >= MAX_DEPOTS} data-testid="ghost-create" onClick={onGhost}
          title={ghostCheck.ok ? "Eine eingefrorene Kopie dieses Depots anlegen" : ghostCheck.reason}>Geisterdepot anlegen</button>
        <button className="btn small" onClick={() => { setName(active.name); setOpen(true); }}>Depot verwalten</button>
        {!disabled && !ghostCheck.ok && !ghost && <span className="muted note-inline" data-testid="ghost-reason" title={ghostCheck.reason}>Geisterdepot: {ghostCheck.reason}</span>}
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
            {lastNormal
              ? "Das letzte Depot lässt sich nicht löschen."
              : `Löscht ${active.name} mit ${active.positions.length} Positionen und ${active.orders.filter((o) => o.status === "open").length} offenen Aufträgen.`}
          </p>
          <button type="button" className="btn" disabled={lastNormal || disabled}
            onClick={() => { onRemove(active.id); setOpen(false); }}>Depot löschen</button>
        </form>
      </dialog>
    </section>
  );
}
