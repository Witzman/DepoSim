import type { MarketEvent } from "../types.js";

const MARK = { dividend: "D", split: "S", gap: "G" } as const;
const NAME = { dividend: "Ausschüttung", split: "Split", gap: "Kurslücke" } as const;
const SHOWN = 6;

const dayText = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;

interface Props {
  /** Events of the shown symbol, oldest first. */
  events: MarketEvent[];
  symbol: string;
}

/** A strip of the latest events under the chart, and the full list behind it. Nothing here is newer than the clock. */
export function EventStrip({ events, symbol }: Props) {
  const latest = events.slice(-SHOWN).reverse();
  return (
    <div className="event-strip" data-testid="event-strip">
      {events.length === 0 ? (
        <p className="muted" data-testid="events-none">Keine Ausschüttung, kein Split und keine Kurslücke für {symbol} im gezeigten Zeitraum.</p>
      ) : (
        <>
          <ul className="chips" aria-label={`Letzte Ereignisse ${symbol}`}>
            {latest.map((e) => (
              <li key={e.key} className={`chip ev-${e.kind}`} title={e.text} data-testid={`event-${e.kind}`}>
                <span className="mark" aria-hidden="true">{MARK[e.kind]}</span> {NAME[e.kind]} {dayText(e.day)}
              </li>
            ))}
          </ul>
          {events.length > SHOWN && <p className="muted">und {events.length - SHOWN} ältere</p>}
          <details>
            <summary>Ereignisliste ({events.length})</summary>
            <ul className="event-list" data-testid="event-list">
              {[...events].reverse().map((e) => <li key={e.key}><span className="num">{e.day.slice(8, 10)}.{e.day.slice(5, 7)}.{e.day.slice(0, 4)}</span> {e.text}</li>)}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
