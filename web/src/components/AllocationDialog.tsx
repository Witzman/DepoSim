import { useEffect, useRef, useState } from "react";
import { allocate } from "../api.js";
import { formatEur } from "../format.js";
import type { AllocationLine, Instrument } from "../types.js";

interface Props {
  open: boolean;
  simulationId: number;
  depotId: number;
  depotName: string;
  instruments: Instrument[];
  onClose: () => void;
}

interface Row {
  symbol: string;
  percent: string;
}

/** Shares in percent become market buys: shown first as a plan, placed on the second click. */
export function AllocationDialog({ open, simulationId, depotId, depotName, instruments, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [lines, setLines] = useState<AllocationLine[] | null>(null);
  const [placed, setPlaced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setRows([{ symbol: instruments[0]?.symbol ?? "", percent: "" }]);
      setLines(null);
      setPlaced(false);
      setError(null);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const sum = rows.reduce((s, r) => s + (Number(r.percent.replace(",", ".")) || 0), 0);
  const weights = () => rows.map((r) => ({ symbol: r.symbol, percent: Number(r.percent.replace(",", ".")) }));
  const valid = rows.length > 0 && rows.every((r) => r.symbol && Number(r.percent.replace(",", ".")) > 0) && sum <= 100 + 1e-9;

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      setLines(await allocate(simulationId, depotId, weights(), dryRun));
      setPlaced(!dryRun);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const update = (i: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
    setLines(null);
  };

  return (
    <dialog ref={dialog} className="allocation" aria-label="Aufbau nach Prozent" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (valid && !placed) void run(true); }}>
        <h2>Aufbau nach Prozent · {depotName}</h2>
        {rows.map((r, i) => (
          <div className="alloc-row" key={i}>
            <select aria-label={`Wertpapier ${i + 1}`} value={r.symbol} onChange={(e) => update(i, { symbol: e.target.value })}>
              {instruments.map((x) => <option key={x.symbol} value={x.symbol}>{x.symbol} · {x.name}</option>)}
            </select>
            <input aria-label={`Anteil ${i + 1} in Prozent`} inputMode="decimal" placeholder="%" value={r.percent}
              onChange={(e) => update(i, { percent: e.target.value })} />
            <button type="button" className="btn small" aria-label={`Zeile ${i + 1} entfernen`}
              onClick={() => { setRows((p) => p.filter((_, k) => k !== i)); setLines(null); }}>×</button>
          </div>
        ))}
        <div className="row">
          <button type="button" className="btn small" disabled={rows.length >= 20}
            onClick={() => setRows((p) => [...p, { symbol: instruments[0]?.symbol ?? "", percent: "" }])}>Zeile hinzufügen</button>
          <span className={`num ${sum > 100 ? "error" : "muted"}`} data-testid="alloc-sum">Summe {sum.toLocaleString("de-DE")} %</span>
        </div>

        {lines && (
          <table className="positions num" data-testid="alloc-result">
            <thead><tr><th>Wertpapier</th><th>Anteil</th><th>Stück</th><th>Summe</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.symbol}>
                  <td>{l.symbol}</td><td>{l.percent} %</td><td>{l.qty}</td>
                  <td>{l.skipped ? <span className="muted">{l.skipped}</span> : formatEur(l.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {placed && <p role="status">Die Kauforders sind gelegt. Bei geschlossenem Markt warten sie auf die Öffnung.</p>}
        {error && <p className="error" role="alert">{error}</p>}

        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>{placed ? "Schließen" : "Abbrechen"}</button>
          {!placed && <button type="submit" className="btn" disabled={!valid || busy}>Vorschau</button>}
          {!placed && (
            <button type="button" className="btn primary" disabled={!valid || busy || !lines || lines.every((l) => l.qty === 0)}
              onClick={() => void run(false)}>Orders erzeugen</button>
          )}
        </div>
      </form>
    </dialog>
  );
}
