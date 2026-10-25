import { formatEur, signedEur, signedPercent } from "../format.js";
import { useEffect, useRef, useState } from "react";
import type { DepotView } from "../types.js";

interface Props {
  depot: DepotView;
  startCash: number;
}

function Change({ value, base }: { value: number; base: number }) {
  const d = value - base;
  const cls = d > 0 ? "up" : d < 0 ? "down" : "muted";
  const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "•";
  return (
    <span className={`${cls} num`}>
      {arrow} {signedEur(d)}{base > 0 ? ` (${signedPercent(d / base)})` : ""}
    </span>
  );
}

/** True for a moment after the value changed; the CSS decides whether that shows (reduced motion: it does not). */
function useFlash(value: number): boolean {
  const [on, setOn] = useState(false);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    setOn(true);
    const timer = setTimeout(() => setOn(false), 700);
    return () => clearTimeout(timer);
  }, [value]);
  return on;
}

function Row({ p }: { p: DepotView["positions"][number] }) {
  const flash = useFlash(p.value);
  return (
    <tr data-testid={`position-${p.symbol}`} className={flash ? "flash" : undefined}>
      <td>{p.symbol}</td><td>{p.qty}</td><td>{formatEur(p.cost)}</td><td>{formatEur(p.value)}</td>
      <td><Change value={p.value} base={p.cost} /></td>
    </tr>
  );
}

export function DepotPanel({ depot, startCash }: Props) {
  return (
    <section className="card" aria-label="Depot">
      <h2>{depot.name}{depot.kind === "ghost" && <span className="badge ghost">Geist</span>}</h2>
      {depot.kind === "ghost" && <p className="muted" data-testid="ghost-note">Geisterdepot: eingefroren und nur zum Ansehen. Es wird weiter bewertet, aber nie gehandelt.</p>}
      <dl className="totals num">
        <dt>Depotwert</dt><dd data-testid="depot-value"><strong>{formatEur(depot.value)}</strong></dd>
        <dt>Guthaben</dt><dd data-testid="cash">{formatEur(depot.cash)}</dd>
        <dt>Seit Start</dt><dd data-testid="since-start"><Change value={depot.value} base={startCash} /></dd>
      </dl>
      {depot.positions.length === 0 ? (
        <p className="muted">Noch keine Positionen.</p>
      ) : (
        <div className="scroll">
        <table className="positions num">
          <thead><tr><th>Wertpapier</th><th>Stück</th><th>Kosten</th><th>Wert</th><th>G/V</th></tr></thead>
          <tbody>
            {depot.positions.map((p) => <Row key={p.symbol} p={p} />)}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}
