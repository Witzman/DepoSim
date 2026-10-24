import { formatPrice } from "../format.js";
import type { Instrument, Snapshot, Venue } from "../types.js";

interface Props {
  instruments: Instrument[];
  prices: Snapshot["prices"];
  venues: Snapshot["venues"] | undefined;
  selected: string;
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onBackfill: () => void;
  /** False on the phone, where the button sits outside the folded list. */
  showBackfill?: boolean;
}

const VENUES: { venue: Venue; label: string }[] = [
  { venue: "XETRA", label: "Xetra" },
  { venue: "US", label: "US-Börsen" },
];

export function Watchlist({ instruments, prices, venues, selected, onSelect, onRemove, onBackfill, showBackfill = true }: Props) {
  return (
    <section className="card" aria-label="Watchlist" data-testid="watchlist">
      {VENUES.map(({ venue, label }) => {
        const list = instruments.filter((i) => i.venue === venue);
        if (list.length === 0) return null;
        const open = venues?.[venue];
        return (
          <div key={venue} className="venue">
            <div className="row">
              <h2>{label}</h2>
              <span className={open ? "up" : "muted"} data-testid={`venue-${venue}`}>
                {venues === undefined ? "" : open ? "● offen" : "○ geschlossen"}
              </span>
            </div>
            <ul className="watch">
              {list.map((i) => (
                <li key={i.symbol} className="watch-item">
                  <button className="watch-row" aria-current={i.symbol === selected} onClick={() => onSelect(i.symbol)}>
                    <span>{i.symbol}<span className="muted"> {i.name}</span></span>
                    <span className="num">{prices[i.symbol] ? formatPrice(prices[i.symbol].price, i.currency) : "–"}</span>
                  </button>
                  {i.added && (
                    <button className="btn small" aria-label={`${i.symbol} entfernen`} title="Aus der Liste entfernen"
                      onClick={() => onRemove(i.symbol)}>×</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {showBackfill && <button className="btn small" data-testid="backfill-open" onClick={onBackfill}>Fehlende Kurse nachladen</button>}
    </section>
  );
}
