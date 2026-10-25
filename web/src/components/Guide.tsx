import { useEffect, useSyncExternalStore } from "react";
import { type GuideFacts, STEPS, dismissGuide, doneSteps, guideSnapshot, latchDone, restartGuide, subscribeGuide, targetOf } from "../guide.js";

interface Props {
  started: boolean;
  orders: GuideFacts["orders"];
  simulations: number;
  onHowto: () => void;
}

/** A small checklist at the edge; the control of the current step pulses. Nothing is forced. */
export function Guide({ started, orders, simulations, onHowto }: Props) {
  const stored = useSyncExternalStore(subscribeGuide, guideSnapshot);
  const seen = new Set(stored?.seen ?? []);
  const facts: GuideFacts = { started, orders, seen };
  const done = doneSteps(facts, stored?.done ?? []);
  const current = STEPS.find((s) => !done.includes(s.id));
  const active = stored !== null && !stored.dismissed;

  useEffect(() => {
    if (active) latchDone(done);
  }, [active, done.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = active && current ? targetOf(current.id, facts, simulations) : null;
  useEffect(() => {
    if (!target) return;
    const nodes = [...document.querySelectorAll<HTMLElement>(`[data-guide="${target}"]`)];
    nodes.forEach((n) => n.classList.add("guide-pulse"));
    return () => nodes.forEach((n) => n.classList.remove("guide-pulse"));
  }, [target, started, orders.length]);

  if (!active) return null;
  return (
    <aside className="guide" aria-label="Erste Schritte" data-testid="guide">
      <div className="guide-head">
        <strong>Erste Schritte <span className="muted num" data-testid="guide-progress">{done.length}/{STEPS.length}</span></strong>
        <span><button className="btn small" onClick={onHowto} data-testid="guide-howto">Anleitung</button> <button className="btn small" onClick={dismissGuide} data-testid="guide-hide">Ausblenden</button></span>
      </div>
      {current ? <p className="guide-now" data-testid="guide-now"><strong>{current.title}</strong></p> : null}
      {current ? <p className="guide-text" data-testid="guide-text">{current.text}</p> : (
        <p className="guide-text" data-testid="guide-finished">Geschafft. Du kennst jetzt die wichtigsten Handgriffe.</p>
      )}
      <details className="guide-all">
        <summary>Alle Schritte</summary>
      <ol className="guide-list">
          {STEPS.map((s) => (
            <li key={s.id} className={done.includes(s.id) ? "done" : s.id === current?.id ? "current" : undefined} data-testid={`guide-step-${s.id}`}
              aria-current={s.id === current?.id ? "step" : undefined}>
              <span aria-hidden="true">{done.includes(s.id) ? "✓" : "○"}</span> {s.title}
              <span className="sr-only">{done.includes(s.id) ? " (erledigt)" : ""}</span>
            </li>
          ))}
        </ol>
        <div className="guide-foot"><button className="btn small" onClick={restartGuide}>Von vorn</button></div>
      </details>
    </aside>
  );
}
