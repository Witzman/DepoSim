interface Props {
  disabled: boolean;
  running: boolean;
  onBuy: () => void;
  onSell: () => void;
  onToggleRun: () => void;
}

/** The three actions of a phone, fixed at the bottom where the thumb is. */
export function MobileBar({ disabled, running, onBuy, onSell, onToggleRun }: Props) {
  return (
    <div className="mobile-bar" role="toolbar" aria-label="Schnellaktionen">
      <button className="btn buy" disabled={disabled} onClick={onBuy}>Kaufen</button>
      <button className="btn sell" disabled={disabled} onClick={onSell}>Verkaufen</button>
      <button className="btn primary" disabled={disabled} onClick={onToggleRun}>{running ? "Pause" : "Start"}</button>
    </div>
  );
}
