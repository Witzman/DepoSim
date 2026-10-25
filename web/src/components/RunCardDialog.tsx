import { useEffect, useRef, useState } from "react";
import { formatEur, formatPercentPlain, signedPercent } from "../format.js";
import { cardText, serializeCard } from "../runCard.js";
import { CARD_H, CARD_W, drawRunCard, fileNameOf, renderRunCard } from "../runCardImage.js";
import { rememberStars, starText } from "../scenarioStars.js";
import type { RunSummary } from "../types.js";
import { GoalList } from "./ScenarioGoals.js";

interface Props {
  run: RunSummary | null;
  open: boolean;
  onClose: () => void;
}

const canvasBlob = (canvas: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));

/** The result card of a round: grade, figures, stars of a scenario, and the ways to take it along. */
export function RunCardDialog({ run, open, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && run && !d.open) { setMessage(null); d.showModal(); }
    if ((!open || !run) && d.open) d.close();
  }, [open, run]);

  useEffect(() => {
    const ctx = open && run ? preview.current?.getContext("2d") : null;
    if (ctx && run) drawRunCard(ctx, run);
  }, [open, run]);

  useEffect(() => {
    if (run?.finished && run.scenario) rememberStars(run.scenario.scenarioId, run.scenario.stars);
  }, [run?.finished, run?.scenario?.scenarioId, run?.scenario?.stars]); // eslint-disable-line react-hooks/exhaustive-deps

  async function savePng() {
    if (!run) return;
    const blob = await (async () => { const c = renderRunCard(run); return c ? canvasBlob(c) : null; })();
    if (!blob) { setMessage("Das Bild konnte nicht erzeugt werden."); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileNameOf(run);
    a.click();
    URL.revokeObjectURL(url);
    setMessage("Bild gespeichert.");
  }

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(done);
    } catch {
      setMessage("Kopieren ist hier nicht erlaubt. Markiere den Text unten und kopiere ihn von Hand.");
    }
  }

  async function share() {
    if (!run) return;
    const c = renderRunCard(run);
    const blob = c ? await canvasBlob(c) : null;
    const file = blob ? new File([blob], fileNameOf(run), { type: "image/png" }) : null;
    try {
      if (file && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text: cardText(run) });
      else await navigator.share({ text: cardText(run) });
    } catch (err) {
      if ((err as Error).name !== "AbortError") setMessage("Teilen ist hier nicht möglich. Nimm Bild oder Text.");
    }
  }

  const g = run?.grade;
  return (
    <dialog ref={dialog} onClose={onClose} data-testid="run-card" className="run-card">
      {run && g && (
        <div>
          <h1>{run.name}{!run.finished && <span className="badge">läuft noch</span>}</h1>
          <div className="grade-row">
            <p className={`grade grade-${g.grade ?? "none"}`} data-testid="run-grade" aria-label={g.grade ? `Note ${g.grade}` : "Ohne Note"}>{g.grade ?? "–"}</p>
            <div>
              <p className="num">{g.score !== null ? `${g.score.toFixed(1).replace(".", ",")} Punkte` : g.note}</p>
              {run.scenario && <p className="stars big" data-testid="result-stars" aria-label={`${run.scenario.stars} von 3 Sternen`}>{starText(run.scenario.stars)}</p>}
              <p className="muted num">
                Rendite {run.totalReturn === null ? "—" : signedPercent(run.totalReturn)}
                {run.benchmarkSymbol && <> · Maßstab {run.benchmarkReturn === null ? "—" : signedPercent(run.benchmarkReturn)}</>}
                {" · "}Rückgang {formatPercentPlain(run.maxDrawdown === null ? null : -run.maxDrawdown)}
                {" · "}Gebühren {formatEur(run.fees)} · {run.trades} Aufträge
              </p>
            </div>
          </div>

          {g.parts.length > 0 && (
            <ul className="grade-parts" data-testid="grade-parts">
              {g.parts.map((p) => (
                <li key={p.key}><span>{p.label}</span> <span className="num">{Math.round(p.score)} / 100</span> <span className="muted">Gewicht {Math.round(p.weight * 100)} % · {p.detail}</span></li>
              ))}
            </ul>
          )}
          {g.note && g.grade && <p className="muted">{g.note}</p>}
          <details><summary>So entsteht die Note</summary><p className="muted" data-testid="grade-formula">{run.gradeFormula}</p></details>

          {run.scenario && <GoalList result={run.scenario} />}

          <canvas ref={preview} width={CARD_W} height={CARD_H} className="card-preview" data-testid="card-canvas"
            role="img" aria-label={`Ergebniskarte: ${cardText(run).replace(/\n/g, ". ")}`} />
          <textarea readOnly className="card-text" rows={5} value={cardText(run)} aria-label="Ergebnistext" data-testid="card-text" onFocus={(e) => e.currentTarget.select()} />
          {message && <p className="muted" role="status" data-testid="card-message">{message}</p>}
          <div className="actions">
            <button className="btn" onClick={() => void savePng()} data-testid="card-png">Bild speichern</button>
            <button className="btn" onClick={() => void copy(cardText(run), "Text kopiert.")} data-testid="card-copy">Text kopieren</button>
            <button className="btn" onClick={() => void copy(serializeCard(run), "Karte kopiert. Wer sie unter „Karte einfügen“ einfügt, spielt dieselbe Runde.")} data-testid="card-json">Karte kopieren</button>
            {typeof navigator.share === "function" && <button className="btn" onClick={() => void share()}>Teilen</button>}
            <button className="btn primary" onClick={onClose}>Schließen</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
