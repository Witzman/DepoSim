import { formatEur, formatPrice } from "../format.js";
import { formatSimTime } from "../time.js";
import type { Instrument, OrderRecord } from "../types.js";

interface Props {
  orders: OrderRecord[];
  instruments: Instrument[];
  disabled: boolean;
  onCancel: (orderId: number) => void;
}

const side = (o: OrderRecord) => (o.side === "buy" ? "Kauf" : "Verkauf");
const kind = (o: OrderRecord) => (o.kind === "limit" ? "Limit" : "Market");

export function OrdersPanel({ orders, instruments, disabled, onCancel }: Props) {
  const currency = (symbol: string) => instruments.find((i) => i.symbol === symbol)?.currency ?? "EUR";
  const open = orders.filter((o) => o.status === "open");
  const done = orders.filter((o) => o.status !== "open").slice().reverse().slice(0, 10);

  return (
    <section className="card" aria-label="Aufträge">
      <h2>Offene Aufträge</h2>
      {open.length === 0 ? <p className="muted">Keine offenen Aufträge.</p> : null}
      <ul className="orders" data-testid="orders-open">
        {open.map((o) => (
          <li key={o.id} data-testid={`order-${o.id}`}>
            <span>{side(o)} {o.qty} × {o.symbol} · {kind(o)}
              {o.limitPrice !== undefined && <span className="num"> {formatPrice(o.limitPrice, currency(o.symbol))}</span>}
            </span>
            <button className="btn small" disabled={disabled} onClick={() => onCancel(o.id)}>Löschen</button>
          </li>
        ))}
      </ul>

      <h2 className="gap-top">Zuletzt</h2>
      {done.length === 0 ? <p className="muted">Noch nichts ausgeführt.</p> : null}
      <ul className="orders" data-testid="orders-done">
        {done.map((o) => (
          <li key={o.id} className={o.status === "filled" ? "" : "muted"}>
            <span>
              {side(o)} {o.qty} × {o.symbol}
              {o.status === "filled" && o.fillPrice !== undefined
                ? <span className="num"> zu {formatPrice(o.fillPrice, currency(o.symbol))}, Gebühren {formatEur((o.commission ?? 0) + (o.foreignFee ?? 0))}</span>
                : <span> · {o.status === "cancelled" ? "gelöscht" : "abgelehnt"}</span>}
            </span>
            {o.filledSim !== undefined && <span className="muted num">{formatSimTime(o.filledSim)}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
