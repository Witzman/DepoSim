import { useEffect, useMemo, useState } from "react";
import { getRuns } from "../api.js";
import { signedPercent } from "../format.js";
import { PRESET_LABEL } from "../rules.js";
import { parseCard, type RunCard } from "../runCard.js";
import { starText } from "../scenarioStars.js";
import type { RunSummary } from "../types.js";

interface Props {
  /** Changes when a round ends or is deleted, so the book is read again. */
  version: string;
  onOpen: (id: number) => void;
  /** Starts the scenario round of a pasted card; rejects with a message to show. */
  onImport: (card: RunCard) => Promise<void>;
}

type Sort = "newest" | "grade" | "return";
type Kind = "all" | "scenario" | "free";

const GRADE_RANK: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1 };
const when = (s: number | null) => (s === null ? "" : new Date(s * 1000).toLocaleDateString("de-DE"));

/** Finished rounds with their grade; sorted, filtered, with the best round of each scenario marked. */
export function RunBook({ version, onOpen, onImport }: Props) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<Sort>("newest");
  const [kind, setKind] = useState<Kind>("all");
  const [preset, setPreset] = useState<string>("all");
  const [paste, setPaste] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getRuns().then((r) => { if (alive) { setRuns(r); setFailed(false); } }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [version]);

  const best = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs ?? []) {
      if (!r.scenarioId || r.grade.score === null) continue;
      const cur = m.get(r.scenarioId);
      const top = cur === undefined ? undefined : (runs ?? []).find((x) => x.id === cur);
      if (!top || (top.grade.score ?? -1) < r.grade.score) m.set(r.scenarioId, r.id);
    }
    return new Set(m.values());
  }, [runs]);

  const shown = useMemo(() => {
    const list = (runs ?? []).filter((r) => (kind === "all" || (kind === "scenario") === (r.scenarioId !== null)) && (preset === "all" || r.preset === preset));
    const by: Record<Sort, (a: RunSummary, b: RunSummary) => number> = {
      newest: (a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.id - a.id,
      grade: (a, b) => (GRADE_RANK[b.grade.grade ?? ""] ?? 0) - (GRADE_RANK[a.grade.grade ?? ""] ?? 0) || (b.grade.score ?? -1) - (a.grade.score ?? -1),
      return: (a, b) => (b.totalReturn ?? -Infinity) - (a.totalReturn ?? -Infinity),
    };
    return [...list].sort(by[sort]);
  }, [runs, sort, kind, preset]);

  async function importCard() {
    setImportError(null);
    const parsed = parseCard(paste.trim());
    if (!parsed.ok) { setImportError(parsed.reason); return; }
    if (!parsed.card.scenarioId) { setImportError("Diese Karte hat kein Szenario. Nachspielen geht nur mit Szenario-Runden."); return; }
    setBusy(true);
    try {
      await onImport(parsed.card);
      setPaste("");
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Rundenbuch" data-testid="runbook">
      <div className="toolbar"><h2>Rundenbuch</h2></div>
      {failed && <p className="muted" role="status">Das Rundenbuch konnte nicht gelesen werden.</p>}
      {runs !== null && runs.length === 0 && <p className="muted">Noch keine beendete Runde. Wer eine Simulation beendet, findet sie hier mit Note.</p>}
      {runs !== null && runs.length > 0 && (
        <>
          <div className="runbook-filters">
            <label>Sortierung
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} data-testid="runbook-sort">
                <option value="newest">Neueste</option><option value="grade">Beste Note</option><option value="return">Beste Rendite</option>
              </select>
            </label>
            <label>Typ
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} data-testid="runbook-kind">
                <option value="all">Alle</option><option value="scenario">Szenarien</option><option value="free">Freie Runden</option>
              </select>
            </label>
            <label>Regeln
              <select value={preset} onChange={(e) => setPreset(e.target.value)} data-testid="runbook-preset">
                <option value="all">Alle</option>
                {(["relaxed", "realistic", "hardcore", "custom"] as const).map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
              </select>
            </label>
          </div>
          <ul className="sim-list" data-testid="runbook-list">
            {shown.map((r) => (
              <li key={r.id} className="sim-item" onClick={() => onOpen(r.id)} data-testid={`run-${r.id}`}>
                <div className="row">
                  <strong>{r.name}</strong>
                  <span className={`grade-badge grade-${r.grade.grade ?? "none"}`} aria-label={r.grade.grade ? `Note ${r.grade.grade}` : "Ohne Note"}>{r.grade.grade ?? "–"}</span>
                </div>
                <div className="muted num">
                  {when(r.endedAt)} · {PRESET_LABEL[r.preset]} · {r.totalReturn === null ? "—" : signedPercent(r.totalReturn)}
                  {r.scenarioTitle && <> · {r.scenarioTitle}{r.scenario && <> <span className="stars">{starText(r.scenario.stars)}</span></>}</>}
                  {best.has(r.id) && <> <span className="badge" title="Beste Note in diesem Szenario">Bestwert</span></>}
                </div>
              </li>
            ))}
            {shown.length === 0 && <li className="muted">Keine Runde passt zum Filter.</li>}
          </ul>
        </>
      )}
      <details>
        <summary>Karte einfügen</summary>
        <label>Eingefügte Runde (JSON)
          <textarea rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} data-testid="runbook-paste" />
        </label>
        {importError && <p className="error" role="alert">{importError}</p>}
        <button className="btn small" disabled={busy || paste.trim() === ""} onClick={() => void importCard()} data-testid="runbook-import">Runde starten</button>
      </details>
    </section>
  );
}
