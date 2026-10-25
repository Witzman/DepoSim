import { useEffect, useRef, useState } from "react";
import { getHints, setHintPref } from "../api.js";
import { entryOf } from "../glossary.js";
import type { HintRule, HintsResult } from "../types.js";

const REFRESH_MS = 5000;

interface Props {
  simulationId: number;
  depotId: number;
  running: boolean;
  /** Changes when the depot does (an order filled), so the hints follow. */
  version: number;
  /** The card is shown (the trade view); the count and the settings dialog work in every view. */
  showCard: boolean;
  /** The settings dialog is open. */
  settingsOpen: boolean;
  onSettings: (open: boolean) => void;
  onCount: (n: number) => void;
  /** Opens the glossary at the entry that explains the figure. */
  onWhy: (query: string) => void;
}

const asPct = (x: number) => `${Math.round(x * 1000) / 10}`.replace(".", ",");
const toShare = (s: string) => Number(s.replace(",", ".")) / 100;

/** The hints that apply now, with the figure and the threshold, and the settings of every rule. */
export function Hints({ simulationId, depotId, running, showCard, version, settingsOpen, onSettings, onCount, onWhy }: Props) {
  const [data, setData] = useState<HintsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const load = () =>
    getHints(simulationId, depotId).then((d) => { setData(d); setError(null); onCount(d.hints.length); }).catch((e: Error) => setError(e.message));

  useEffect(() => {
    let current = true;
    const run = () => getHints(simulationId, depotId).then((d) => { if (current) { setData(d); setError(null); onCount(d.hints.length); } }).catch((e: Error) => current && setError(e.message));
    void run();
    const timer = running ? setInterval(run, REFRESH_MS) : undefined;
    return () => { current = false; if (timer) clearInterval(timer); };
  }, [simulationId, depotId, running, version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (settingsOpen && !d.open) d.showModal();
    if (!settingsOpen && d.open) d.close();
  }, [settingsOpen]);

  async function change(rule: string, patch: { enabled?: boolean; hidden?: boolean; levels?: number[] }) {
    try {
      await setHintPref(simulationId, rule, patch);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const anyOn = data?.rules.some((r) => r.enabled) ?? false;
  const why = (id: string) => onWhy(entryOf(id)?.name ?? "");

  return (
    <>
      {showCard && data && anyOn && data.hints.length > 0 && (
        <section className="card" aria-label="Hinweise" id="hints" data-testid="hints">
          <div className="toolbar">
            <h2>Hinweise · {data.hints.length}</h2>
            <button className="btn small" onClick={() => onSettings(true)}>Einstellungen</button>
          </div>
          <ul className="hint-list">
            {data.hints.map((h) => (
              <li key={h.rule} className={`hint-item ${h.severity}`} data-testid={`hint-rule-${h.rule}`}>
                <span className={`badge ${h.severity === "warn" ? "warn" : "ghost"}`}>{h.severity === "warn" ? "Achtung" : "Info"}</span>
                <span>{h.text}</span>
                <span className="hint-actions">
                  <button className="btn small" onClick={() => why(h.why)}>Warum?</button>
                  <button className="btn small" onClick={() => void change(h.rule, { hidden: true })}>Ausblenden</button>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">Beobachtungen nach festen Regeln, keine Empfehlung zum Kaufen oder Verkaufen. Es zählt nur, was zur Simulationszeit gilt.</p>
        </section>
      )}
      {error && <p className="banner error" role="alert">{error}</p>}
      <dialog ref={dialog} className="hints-settings" data-testid="hints-settings" aria-label="Hinweise einstellen" onClose={() => onSettings(false)}>
        <h2>Hinweise einstellen</h2>
        <p className="muted">Gilt für diese Simulation. Schwellen in Prozent des Depotwerts, die Verlustserie in Trades.</p>
        <ul className="rule-list">
          {(data?.rules ?? []).map((r) => <RuleRow key={r.rule} r={r} onChange={(p) => void change(r.rule, p)} />)}
        </ul>
        <div className="actions"><button className="btn" onClick={() => onSettings(false)}>Schließen</button></div>
      </dialog>
    </>
  );
}

function RuleRow({ r, onChange }: { r: HintRule; onChange: (p: { enabled?: boolean; hidden?: boolean; levels?: number[] }) => void }) {
  const [draft, setDraft] = useState(r.levels.map((l) => (r.unit === "share" ? asPct(l) : String(l))));
  useEffect(() => setDraft(r.levels.map((l) => (r.unit === "share" ? asPct(l) : String(l)))), [r.levels, r.unit]);
  const commit = () => {
    const levels = draft.map((d) => (r.unit === "share" ? toShare(d) : Number(d.replace(",", "."))));
    if (levels.every((x) => Number.isFinite(x)) && levels.some((x, i) => x !== r.levels[i])) onChange({ levels });
  };
  return (
    <li data-testid={`rule-${r.rule}`}>
      <label className="check">
        <input type="checkbox" checked={r.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        <span>{r.label}</span>
      </label>
      {r.defaults.length > 0 && draft.map((d, i) => (
        <label key={i} className="level">
          <span className="muted">{r.defaults.length > 1 ? (i === 0 ? "Info ab" : "Achtung ab") : "Schwelle"}</span>
          <input inputMode="decimal" value={d} disabled={!r.enabled} aria-label={`${r.label}, Schwelle ${i + 1}`}
            onChange={(e) => setDraft((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} onBlur={commit} />
          <span className="muted">{r.unit === "share" ? "%" : ""}</span>
        </label>
      ))}
      {r.hidden && <button className="btn small" onClick={() => onChange({ hidden: false })}>Wieder einblenden</button>}
    </li>
  );
}
