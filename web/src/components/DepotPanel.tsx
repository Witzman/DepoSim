import { formatEur, signedEur, signedPercent } from "../format.js";
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

export function DepotPanel({ depot, startCash }: Props) {
  return (
    <section className="card" aria-label="Depot">
      <h2>{depot.name}</h2>
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
            {depot.positions.map((p) => (
              <tr key={p.symbol} data-testid={`position-${p.symbol}`}>
                <td>{p.symbol}</td><td>{p.qty}</td><td>{formatEur(p.cost)}</td><td>{formatEur(p.value)}</td>
                <td><Change value={p.value} base={p.cost} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}
