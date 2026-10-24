import { useEffect, useRef, useState } from "react";
import { getOrderbook } from "../api.js";
import { formatPrice } from "../format.js";
import { throttleDelay } from "../throttle.js";
import type { Instrument, Orderbook as Book } from "../types.js";

export const ORDERBOOK_MIN_GAP_MS = 5000;

interface Props {
  simulationId: number;
  instrument: Instrument | undefined;
  /** Changes on every snapshot or tick; a fetch follows at most every five seconds. */
  simulationTime: number;
  open: boolean;
  onToggle: () => void;
}

/** A collapsible, simulated order book under the ticket. Display only. */
export function OrderbookPanel({ simulationId, instrument, simulationTime, open, onToggle }: Props) {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastAt = useRef<number | null>(null);
  const seq = useRef(0);
  const symbol = instrument?.symbol;

  // Another symbol or simulation: the old book is not shown for the new one, and the pause starts over.
  useEffect(() => { setBook(null); lastAt.current = null; seq.current++; }, [simulationId, symbol]);

  useEffect(() => {
    if (!open || !symbol) return;
    // An answer counts unless a newer request or another symbol came after it; a tick alone does not drop it.
    const run = () => {
      lastAt.current = Date.now();
      const mine = ++seq.current;
      getOrderbook(simulationId, symbol)
        .then((b) => { if (mine === seq.current) { setBook(b); setError(null); } })
        .catch((e: Error) => { if (mine === seq.current) setError(e.message); });
    };
    const wait = throttleDelay(lastAt.current, Date.now(), ORDERBOOK_MIN_GAP_MS);
    if (wait === 0) run();
    const timer = wait > 0 ? setTimeout(run, wait) : undefined;
    return () => { if (timer) clearTimeout(timer); };
  }, [open, simulationId, symbol, simulationTime]);

  const cur = instrument?.currency ?? "EUR";
  return (
    <section className="card orderbook" aria-label="Orderbuch">
      <button type="button" className="btn small" aria-expanded={open} aria-controls="orderbook-body" data-testid="orderbook-toggle"
        onClick={onToggle}>{open ? "▾" : "▸"} Orderbuch{symbol ? ` · ${symbol}` : ""}</button>
      {open && (
        <div id="orderbook-body" data-testid="orderbook">
          {error && <p className="error" role="alert">{error}</p>}
          {!book && !error && <p className="muted">Lädt …</p>}
          {book && (
            <>
              <p className="banner sim-label" data-testid="orderbook-label"><strong>{book.label}</strong></p>
              {!book.available ? (
                <p data-testid="orderbook-unavailable"><strong>kein Orderbuch</strong> <span className="muted">{book.reason}</span></p>
              ) : (
                <>
                  <div className="scroll">
                    <table className="positions num book">
                      <thead><tr><th>Seite</th><th>Kurs</th><th>Menge</th></tr></thead>
                      <tbody>
                        {[...book.asks].reverse().map((l) => (
                          <tr key={`a${l.price}`} className="ask"><td>Verkauf ▼</td><td>{formatPrice(l.price, cur)}</td><td>{l.size}</td></tr>
                        ))}
                        <tr className="mid"><td>Mitte</td><td>{formatPrice(book.mid, cur)}</td><td /></tr>
                        {book.bids.map((l) => (
                          <tr key={`b${l.price}`} className="bid"><td>Kauf ▲</td><td>{formatPrice(l.price, cur)}</td><td>{l.size}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">Nur zur Ansicht; Orders werden davon nicht beeinflusst.</p>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
