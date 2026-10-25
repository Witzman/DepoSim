import { useEffect, useRef, useState } from "react";
import { feedback, feedbackPrefs, setFeedbackPrefs } from "../feedback.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function FeedbackSettings({ open, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prefs, setPrefs] = useState(feedbackPrefs);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) { setPrefs(feedbackPrefs()); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);

  function change(patch: Partial<typeof prefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setFeedbackPrefs(next);
    // Turning the sound on is answered with the sound: this click is the interaction browsers wait for.
    if (patch.sound) feedback("buy");
  }

  return (
    <dialog ref={dialog} aria-label="Rückmeldung" data-testid="feedback-settings" onClose={onClose}>
      <h2>Rückmeldung</h2>
      <p className="muted">Kleine Signale bei Orders. Dezent, ohne Melodie und ohne Belohnung für Gewinne.</p>
      <label className="check"><input type="checkbox" checked={prefs.sound} onChange={(e) => change({ sound: e.target.checked })} data-testid="fb-sound" /><span>Ton (aus, bis du ihn einschaltest)</span></label>
      <label className="check"><input type="checkbox" checked={prefs.haptics} onChange={(e) => change({ haptics: e.target.checked })} data-testid="fb-haptics" /><span>Vibration auf dem Handy</span></label>
      <label className="check"><input type="checkbox" checked={prefs.reducedMotion} onChange={(e) => change({ reducedMotion: e.target.checked })} data-testid="fb-motion" /><span>Weniger Bewegung (zusätzlich zur Systemeinstellung)</span></label>
      <div className="actions"><button className="btn" onClick={onClose}>Schließen</button></div>
    </dialog>
  );
}
