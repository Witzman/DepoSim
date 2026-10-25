import { useEffect, useMemo, useState } from "react";
import { getCurves } from "../api.js";
import { formatEur, formatPercentPlain } from "../format.js";
import { dailyReturns, DEFAULT_SEED, HORIZON_YEARS, MIN_HISTORY_DAYS, type McInput, type McResult, type Method } from "../monteCarlo.js";
import { useMonteCarlo } from "../useMonteCarlo.js";
import type { Curves, DepotView } from "../types.js";

const REFRESH_MS = 8000;

/** Reads a euro amount typed by a person ("1.500,50" or "1500.5"); null when it is empty or not a number. */
export function parseEuro(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The fan of the paths: median line, bands for 10 to 90 and 5 to 95 percent. A text summary stands for the picture. */
function Fan({ r, years }: { r: McResult; years: number }) {
  const W = 640;
  const H = 220;
  const L = 78;
  const R = 8;
  const T = 8;
  const B = 18;
  const { band } = r;
  const hi = Math.max(...band.p95);
  const lo = Math.min(...band.p5);
  const X = (d: number) => L + (d / r.horizonDays) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const pts = (xs: number[]) => xs.map((v, i) => `${X(band.days[i]).toFixed(1)},${Y(v).toFixed(1)}`);
  const area = (top: number[], bottom: number[]) => [...pts(top), ...pts(bottom).reverse()].join(" ");
  const last = band.days.length - 1;
  return (
    <figure className="rolling-fig">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" className="rolling-svg" data-testid="outlook-fan"
        aria-label={`Simulation über ${years} ${years === 1 ? "Jahr" : "Jahre"}: Median ${formatEur(band.p50[last])}, 10. bis 90. Perzentil ${formatEur(band.p10[last])} bis ${formatEur(band.p90[last])}, 5. bis 95. Perzentil ${formatEur(band.p5[last])} bis ${formatEur(band.p95[last])}`}>
        <line x1={L} x2={W - R} y1={Y(lo)} y2={Y(lo)} className="axis" />
        <line x1={L} x2={W - R} y1={Y(hi)} y2={Y(hi)} className="axis faint" />
        <text x={L - 4} y={Y(hi) + 4} textAnchor="end" className="tick">{formatEur(hi)}</text>
        <text x={L - 4} y={Y(lo)} textAnchor="end" className="tick">{formatEur(lo)}</text>
        <text x={L} y={H - 4} className="tick">heute</text>
        <text x={W - R} y={H - 4} textAnchor="end" className="tick">in {years} {years === 1 ? "Jahr" : "Jahren"}</text>
        <polygon points={area(band.p95, band.p5)} className="fan-outer" />
        <polygon points={area(band.p90, band.p10)} className="fan-inner" />
        <polyline points={pts(band.p50).join(" ")} fill="none" stroke="var(--series-1)" strokeWidth={2} />
        {r.reference > 0 && <line x1={L} x2={W - R} y1={Y(r.reference)} y2={Y(r.reference)} className="axis zero" strokeDasharray="4 4" />}
      </svg>
      <figcaption className="legend">
        <span><span className="swatch" style={{ borderTopColor: "var(--series-1)" }} aria-hidden="true" /> Median</span>
        <span><span className="swatch fan-swatch-inner" aria-hidden="true" /> 10. bis 90. Perzentil</span>
        <span><span className="swatch fan-swatch-outer" aria-hidden="true" /> 5. bis 95. Perzentil</span>
        <span><span className="swatch" style={{ borderTopColor: "var(--muted)", borderTopStyle: "dashed" }} aria-hidden="true" /> eingezahlt</span>
      </figcaption>
    </figure>
  );
}

interface Props {
  simulationId: number;
  depot: DepotView;
  running: boolean;
  benchmark: string | null;
}

/** A look ahead that is no forecast: the depot's own daily returns, shuffled in blocks, many times over. Computed in the browser, off the main thread. */
export function Outlook({ simulationId, depot, running, benchmark }: Props) {
  const [curves, setCurves] = useState<Curves | null>(null);
  const [years, setYears] = useState<number>(1);
  const [method, setMethod] = useState<Method>("bootstrap");
  const [save, setSave] = useState("");
  const [draw, setDraw] = useState("");
  const [goal, setGoal] = useState("");
  const [seedText, setSeedText] = useState(String(DEFAULT_SEED));
  const filled = depot.orders.filter((o) => o.status === "filled").length;

  useEffect(() => {
    let alive = true;
    const load = () => getCurves(simulationId).then((c) => { if (alive) setCurves(c); }).catch(() => undefined);
    load();
    const timer = running ? setInterval(load, REFRESH_MS) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [simulationId, running, filled]);

  const own = useMemo(() => dailyReturns(curves?.depots.find((d) => d.id === depot.id)?.points ?? []), [curves, depot.id]);
  const bench = useMemo(() => dailyReturns(curves?.benchmark?.points ?? []), [curves]);
  const usedBench = method === "normal" && bench.length >= MIN_HISTORY_DAYS;
  const returns = usedBench ? bench : own;
  const seed = Number.isInteger(Number(seedText)) && seedText.trim() !== "" ? Number(seedText) : DEFAULT_SEED;
  const goalEur = parseEuro(goal);
  const input = useMemo<McInput | null>(() => curves === null ? null : {
    returns, startValue: depot.value, years, method, seed,
    monthlySave: (parseEuro(save) ?? 0) * 100, monthlyDraw: (parseEuro(draw) ?? 0) * 100,
    goal: goalEur === null ? null : goalEur * 100,
  }, [curves, returns, depot.value, years, method, seed, save, draw, goalEur]);
  const { result, busy } = useMonteCarlo(input);

  return (
    <section className="card outlook" aria-label="Ausblick" data-testid="outlook">
      <h2>Ausblick (Spielerei mit Aussagekraft)</h2>
      <p className="warn-note" data-testid="outlook-warning" role="note">
        <strong>Das ist eine Simulation, keine Prognose.</strong> Die Vergangenheit sagt nichts Verlässliches über die Zukunft. Gerechnet wird mit
        den bisherigen Tagesrenditen dieses Depots, ohne Gebühren, Steuern und Inflation. Je kürzer die Historie, desto breiter ist die
        Unsicherheit, und die Spanne unten ist selbst nur eine Schätzung.
      </p>

      <div className="rolling-controls">
        <div role="group" aria-label="Horizont" className="group">
          {HORIZON_YEARS.map((y) => (
            <button key={y} className="btn small" aria-pressed={years === y} data-testid={`horizon-${y}`} onClick={() => setYears(y)}>{y} {y === 1 ? "Jahr" : "Jahre"}</button>
          ))}
        </div>
        <label>Verfahren{" "}
          <select value={method} onChange={(e) => setMethod(e.target.value as Method)} data-testid="outlook-method">
            <option value="bootstrap">Blöcke der eigenen Renditen</option>
            <option value="normal" disabled={bench.length < MIN_HISTORY_DAYS}>Normalverteilt mit Rendite und Schwankung des Vergleichswerts{benchmark ? ` (${benchmark})` : ""}</option>
          </select>
        </label>
      </div>
      <div className="rolling-controls">
        <label>Sparrate je Monat (€) <input inputMode="decimal" value={save} onChange={(e) => setSave(e.target.value)} className="narrow-input" data-testid="outlook-save" /></label>
        <label>Entnahme je Monat (€) <input inputMode="decimal" value={draw} onChange={(e) => setDraw(e.target.value)} className="narrow-input" data-testid="outlook-draw" /></label>
        <label>Zielbetrag (€) <input inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value)} className="narrow-input" data-testid="outlook-goal" /></label>
        <label>Zufalls-Seed <input inputMode="numeric" value={seedText} onChange={(e) => setSeedText(e.target.value)} className="narrow-input" data-testid="outlook-seed" /></label>
      </div>

      {!result ? (
        <p className="muted" role="status">{curves === null ? "Die Kurve wird geladen …" : "…"}</p>
      ) : !result.ok ? (
        <p className="muted" data-testid="outlook-refused" role="status">{result.reason} Spiele weiter oder wähle einen früheren Start.</p>
      ) : (
        <div aria-busy={busy}>
          <p className="muted num" data-testid="outlook-meta">
            Simulation: {result.paths.toLocaleString("de-DE")} Pfade, {result.historyDays} Handelstage Historie ({result.method === "normal" ? "normalverteilt" : "Blöcke von 5 Tagen"}), Seed {result.seed}.
            {result.historyDays < 250 && " Die Historie ist kurz: die wahre Spanne ist vermutlich größer."}
          </p>
          <Fan r={result} years={years} />
          <table className="episodes" data-testid="outlook-table">
            <caption className="sr-only">Endwert-Perzentile der Simulation</caption>
            <thead><tr><th scope="col">Perzentil</th><th scope="col" className="num">Endwert</th></tr></thead>
            <tbody>
              {result.end.map((e) => <tr key={e.p}><th scope="row">{e.p}.</th><td className="num">{formatEur(e.value)}</td></tr>)}
            </tbody>
          </table>
          <ul className="plain-list" data-testid="outlook-probs">
            <li className="num">Eingezahlt (netto): <strong>{formatEur(result.reference)}</strong></li>
            <li className="num">Wert unter dem eingezahlten Betrag: <strong data-testid="p-loss">{formatPercentPlain(result.probLoss)}</strong> der Pfade</li>
            <li className="num">Mehr als 20 % darunter: <strong data-testid="p-loss20">{formatPercentPlain(result.probLoss20)}</strong> der Pfade</li>
            {result.probGoal !== null && <li className="num">Zielbetrag {formatEur((goalEur ?? 0) * 100)} erreicht: <strong data-testid="p-goal">{formatPercentPlain(result.probGoal)}</strong> der Pfade</li>}
          </ul>
        </div>
      )}
      {method === "normal" && !usedBench && <p className="muted">Ohne Maßstab mit genug Historie wird mit den eigenen Renditen gerechnet.</p>}
    </section>
  );
}
