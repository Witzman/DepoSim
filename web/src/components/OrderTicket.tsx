import { useEffect, useRef, useState } from "react";
import { placeOrder, previewOrder } from "../api.js";
import { formatEur, formatPrice } from "../format.js";
import type { CostPreview, Instrument, OrderInput } from "../types.js";

interface Props {
  simulationId: number;
  /** The depot the order goes to; the first one while the snapshot is not there yet. */
  depotId: number | undefined;
  instrument: Instrument | undefined;
  /** Changes whenever a new bar finished, so the preview follows the price. */
  priceKey: number | undefined;
  disabled: boolean;
  /** A key press from outside: pick the side and focus the quantity. */
  command: { side: "buy" | "sell"; n: number };
}

export function OrderTicket({ simulationId, depotId, instrument, priceKey, disabled, command }: Props) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState("1");
  const [limit, setLimit] = useState("");
  const [cost, setCost] = useState<CostPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const qtyInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (command.n === 0) return;
    setSide(command.side);
    formRef.current?.scrollIntoView?.({ block: "nearest" });
    qtyInput.current?.focus();
    qtyInput.current?.select();
  }, [command]);

  const order: OrderInput | null = instrument
    ? {
        symbol: instrument.symbol, side, kind, qty: Number(qty), depotId,
        ...(kind === "limit" ? { limitPrice: Number(limit) } : {}),
      }
    : null;
  const key = order && JSON.stringify(order);

  // The server prices the order, so the ticket and the fill can never disagree.
  useEffect(() => {
    if (!order || disabled || qty.trim() === "" || (kind === "limit" && limit.trim() === "")) {
      setCost(null);
      setProblem(null);
      setNotes([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      previewOrder(simulationId, order)
        .then((r) => {
          if (!current) return;
          setCost(r.cost);
          setProblem(r.problem ?? null);
          setNotes(r.notes ?? []);
        })
        .catch((e: Error) => {
          if (!current) return;
          setCost(null);
          setNotes([]);
          setProblem(e.message);
        });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [simulationId, key, priceKey, disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!order) return;
    setBusy(true);
    try {
      await placeOrder(simulationId, order);
      setProblem(null);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const cur = instrument?.currency ?? "EUR";
  const canSend = !!cost && !problem && !busy && !disabled;
  const word = side === "buy" ? "Kaufen" : "Verkaufen";

  return (
    <form ref={formRef} className="card ticket" onSubmit={submit} aria-label="Orderticket">
      <h2>Order {instrument ? `· ${instrument.symbol}` : ""}</h2>
      <div className="group" role="group" aria-label="Seite">
        <button type="button" className="btn" aria-pressed={side === "buy"} onClick={() => setSide("buy")}>Kauf</button>
        <button type="button" className="btn" aria-pressed={side === "sell"} onClick={() => setSide("sell")}>Verkauf</button>
      </div>
      <div className="fields">
        <label>Art
          <select value={kind} onChange={(e) => setKind(e.target.value as "market" | "limit")}>
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </label>
        <label>Menge
          <input ref={qtyInput} type="number" min="0" step="1" inputMode="numeric" value={qty}
            disabled={!instrument || disabled} onChange={(e) => setQty(e.target.value)} />
        </label>
        {kind === "limit" && (
          <label>Limit ({cur})
            <input type="number" min="0" step="0.01" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </label>
        )}
      </div>

      {cost && (
        <dl className="cost num">
          <dt>Ausführungskurs{kind === "market" ? " (mit Spread)" : ""}</dt><dd>{formatPrice(cost.execPrice, cur)}</dd>
          {cost.fxRateEff !== undefined && (<><dt>Wechselkurs (mit Aufschlag)</dt><dd>1 € = {cost.fxRateEff.toFixed(4)} $</dd><dt>Kursquelle Wechselkurs</dt><dd data-testid="fx-source">Yahoo, Minute</dd></>)}
          <dt>{side === "buy" ? "Kaufwert" : "Verkaufswert"}</dt><dd>{formatEur(cost.gross)}</dd>
          <dt>Provision</dt><dd data-testid="cost-commission">{formatEur(cost.commission)}</dd>
          {cost.foreign > 0 && (<><dt>Auslandspauschale</dt><dd>{formatEur(cost.foreign)}</dd></>)}
          <dt><strong>{side === "buy" ? "Summe (Abfluss)" : "Summe (Zufluss)"}</strong></dt>
          <dd data-testid="cost-total"><strong>{formatEur(cost.total)}</strong></dd>
        </dl>
      )}
      {problem && <p className="error" role="status" data-testid="ticket-problem">{problem}</p>}
      {notes.map((n) => <p key={n} className="note-hint" role="status" data-testid="ticket-note">{n}</p>)}

      <button type="submit" className="btn primary" disabled={!canSend}>{word}</button>
    </form>
  );
}
