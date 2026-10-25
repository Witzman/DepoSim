import { useEffect, useMemo, useState } from "react";
import { getRolling } from "../api.js";
import { formatPercentPlain, formatRatio, signedPercent } from "../format.js";
import type { Analysis, DepotView, RollingResult } from "../types.js";
import { poll } from "../poll.js";

const REFRESH_MS = 8000;
type Measure = "vol" | "sharpe" | "ret";
const MEASURES: { id: Measure; label: string }[] = [
  { id: "vol", label: "Volatilität" }, { id: "sharpe", label: "Sharpe" }, { id: "ret", label: "Rendite" },
];
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const DATE = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" });
const dateText = (t: number) => DATE.format(t * 1000);

const fmt = (m: Measure, v: number | null) => (v === null ? "—" : m === "sharpe" ? formatRatio(v) : m === "ret" ? signedPercent(v) : formatPercentPlain(v));

interface Line { name: string; color: string; dash?: string; points: { t: number; v: number }[] }

/** A line chart in SVG: the depot and, if there is one, the benchmark, on one scale. Numbers at the ends and a text summary for a screen reader. */
function LineChart({ lines, measure, label }: { lines: Line[]; measure: Measure | "beta"; label: string }) {
  const all = lines.flatMap((l) => l.points);
  if (all.length < 2) return <p className="muted">Zu wenige Punkte für eine Linie.</p>;
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  let lo = Math.min(...all.map((p) => p.v));
  let hi = Math.max(...all.map((p) => p.v));
  if (measure === "beta") { lo = Math.min(lo, 0); hi = Math.max(hi, 1); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const W = 640;
  const H = 180;
  const L = 52;
  const R = 8;
  const T = 8;
  const B = 18;
  const X = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const show = (v: number) => (measure === "beta" ? formatRatio(v) : fmt(measure, v));
  const summary = lines.map((l) => `${l.name}: zuletzt ${show(l.points[l.points.length - 1]?.v ?? NaN)}`).join(", ");
  return (
    <figure className="rolling-fig">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}. ${summary}`} className="rolling-svg">
        <line x1={L} x2={W - R} y1={Y(lo)} y2={Y(lo)} className="axis" />
        <line x1={L} x2={W - R} y1={Y(hi)} y2={Y(hi)} className="axis faint" />
        {lo < 0 && hi > 0 && <line x1={L} x2={W - R} y1={Y(0)} y2={Y(0)} className="axis zero" />}
        <text x={L - 4} y={Y(hi) + 4} textAnchor="end" className="tick">{show(hi)}</text>
        <text x={L - 4} y={Y(lo)} textAnchor="end" className="tick">{show(lo)}</text>
        <text x={L} y={H - 4} className="tick">{dateText(t0)}</text>
        <text x={W - R} y={H - 4} textAnchor="end" className="tick">{dateText(t1)}</text>
        {lines.map((l) => (
          <polyline key={l.name} fill="none" stroke={l.color} strokeWidth={2} strokeDasharray={l.dash}
            points={l.points.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ")} />
        ))}
      </svg>
      <figcaption className="legend">
        {lines.map((l) => (
          <span key={l.name}><span className="swatch" style={{ borderTopColor: l.color, borderTopStyle: l.dash ? "dashed" : "solid" }} aria-hidden="true" /> {l.name} <span className="num muted">{show(l.points[l.points.length - 1].v)}</span></span>
        ))}
      </figcaption>
    </figure>
  );
}

function cellStyle(ret: number) {
  const a = Math.min(Math.abs(ret) / 0.1, 1) * 55 + 8;
  return { background: `color-mix(in srgb, var(${ret >= 0 ? "--up" : "--down"}) ${a}%, transparent)` };
}

/** Year by month; every cell carries its number, the colour only adds to it. */
function Heatmap({ a, name }: { a: Analysis; name: string }) {
  if (a.months.length === 0) return <p className="muted">Noch kein voller Monat.</p>;
  const best = a.months.reduce((x, m) => (m.ret > x.ret ? m : x));
  const worst = a.months.reduce((x, m) => (m.ret < x.ret ? m : x));
  return (
    <div className="heat" data-testid={`heat-${name}`}>
      <table>
        <caption className="sr-only">Monatsrenditen {name}</caption>
        <thead><tr><th scope="col">Jahr</th>{MONTHS.map((m) => <th key={m} scope="col">{m}</th>)}<th scope="col">Jahr gesamt</th></tr></thead>
        <tbody>
          {a.years.map((y) => (
            <tr key={y.year}>
              <th scope="row">{y.year}</th>
              {MONTHS.map((_, i) => {
                const m = y.months.find((x) => Number(x.month.slice(5, 7)) === i + 1);
                return m ? <td key={i} className="num" style={cellStyle(m.ret)}>{signedPercent(m.ret)}</td> : <td key={i} className="muted">·</td>;
              })}
              <td className="num total" style={cellStyle(y.ret)}><strong>{signedPercent(y.ret)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted num">Bester Monat {best.month.slice(5, 7)}/{best.month.slice(0, 4)} {signedPercent(best.ret)} · schlechtester {worst.month.slice(5, 7)}/{worst.month.slice(0, 4)} {signedPercent(worst.ret)}</p>
    </div>
  );
}

function Episodes({ a }: { a: Analysis }) {
  if (a.episodes.length === 0) return <p className="muted" data-testid="no-episodes">Noch kein Rückgang vom Höchststand.</p>;
  return (
    <table className="episodes" data-testid="episodes">
      <thead><tr><th scope="col">Beginn</th><th scope="col">Tiefpunkt</th><th scope="col">Ende</th><th scope="col" className="num">Rückgang</th><th scope="col" className="num">Dauer</th></tr></thead>
      <tbody>
        {a.episodes.map((e) => (
          <tr key={e.peakT}>
            <td>{dateText(e.peakT)}</td><td>{dateText(e.troughT)}</td>
            <td>{e.endT === null ? "noch nicht erholt" : dateText(e.endT)}</td>
            <td className="num down">{formatPercentPlain(e.depth)}</td><td className="num">{e.days} T{e.ongoing ? " und mehr" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Props {
  simulationId: number;
  depot: DepotView;
  running: boolean;
  theme: string;
}

/** Rolling figures, months, falls and ranges of the depot against the benchmark. Everything up to the simulation time and not past it. */
export function Rolling({ simulationId, depot, running }: Props) {
  const [data, setData] = useState<RollingResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [window, setWindow] = useState<number | null>(null);
  const [measure, setMeasure] = useState<Measure>("vol");
  const filled = depot.orders.filter((o) => o.status === "filled").length;

  useEffect(() => {
    let alive = true;
    const load = () => getRolling(simulationId, depot.id).then((d) => { if (alive) { setData(d); setFailed(false); } }).catch(() => { if (alive) setFailed(true); });
    load();
    const stop = running ? poll(load, REFRESH_MS) : undefined;
    return () => { alive = false; stop?.(); };
  }, [simulationId, depot.id, running, filled]);

  const usable = useMemo(() => data?.depot.rolling.filter((r) => r.points.length > 0).map((r) => r.window) ?? [], [data]);
  // The largest window the history carries, unless the person chose one.
  const shown = window !== null && usable.includes(window) ? window : usable.length ? usable[usable.length - 1] : null;

  if (failed && !data) return <section className="card" data-testid="rolling"><h2>Verlauf der Kennzahlen</h2><p className="muted" role="status">Die Kennzahlen konnten nicht gelesen werden.</p></section>;
  if (!data) return null;
  const roll = (a: Analysis | null) => a?.rolling.find((r) => r.window === shown)?.points ?? [];
  const lines: Line[] = [{ name: depot.name, color: "var(--series-1)", points: roll(data.depot).map((p) => ({ t: p.t, v: p[measure] as number })).filter((p) => p.v !== null) }];
  if (data.benchmark) lines.push({ name: `Maßstab ${data.benchmark.symbol}`, color: "var(--series-2)", dash: "6 4", points: roll(data.benchmark).map((p) => ({ t: p.t, v: p[measure] as number })).filter((p) => p.v !== null) });
  const drawable = lines.filter((l) => l.points.length >= 2);
  const betaPts = data.beta.points.filter((p) => p.beta !== null);

  return (
    <section className="card rolling" aria-label="Verlauf der Kennzahlen" data-testid="rolling">
      <h2>Verlauf der Kennzahlen</h2>
      <p className="muted">Auf Tageswerten, {data.depot.days} Tage Historie. Am Anfang sind die Werte Rauschen: ein Fenster zeigt erst etwas, wenn es voll ist.</p>

      <div className="rolling-controls">
        <div role="group" aria-label="Fenster" className="group">
          {data.depot.rolling.map((r) => (
            <button key={r.window} className="btn small" aria-pressed={shown === r.window} disabled={r.points.length === 0} data-testid={`window-${r.window}`}
              title={r.points.length === 0 ? `Dafür reichen ${data.depot.days} Tage nicht` : `${r.window} Handelstage`} onClick={() => setWindow(r.window)}>{r.window} T</button>
          ))}
        </div>
        <div role="group" aria-label="Größe" className="group">
          {MEASURES.map((m) => <button key={m.id} className="btn small" aria-pressed={measure === m.id} onClick={() => setMeasure(m.id)}>{m.label}</button>)}
        </div>
      </div>
      {shown === null ? (
        <p className="muted" data-testid="rolling-empty">Noch zu wenig Historie: das kleinste Fenster braucht {data.depot.rolling[0].window + 1} Tage.</p>
      ) : drawable.length === 0 ? (
        <p className="muted">Für diese Größe gibt es im Fenster noch keine Werte.</p>
      ) : (
        <LineChart lines={drawable} measure={measure} label={`${MEASURES.find((m) => m.id === measure)!.label} über ${shown} Handelstage`} />
      )}

      <h3>Beta und Korrelation zum Maßstab ({data.beta.window} Tage)</h3>
      {!data.benchmark ? <p className="muted">Ohne Maßstab gibt es keinen Vergleich. Wähle oben bei den Kurven einen Maßstab.</p>
        : betaPts.length < 2 ? <p className="muted" data-testid="beta-empty">Noch keine {data.beta.window} gemeinsamen Tage.</p>
        : (
          <>
            <LineChart measure="beta" label="Beta zum Maßstab" lines={[{ name: "Beta", color: "var(--series-1)", points: betaPts.map((p) => ({ t: p.t, v: p.beta as number })) }]} />
            <p className="muted num">Korrelation zuletzt {formatRatio(data.beta.points[data.beta.points.length - 1].corr)}</p>
          </>
        )}

      <h3>Monatsrenditen</h3>
      <Heatmap a={data.depot} name="depot" />
      {data.benchmark && <><h4>{data.benchmark.name} (Maßstab, nur Kurs)</h4><Heatmap a={data.benchmark} name="benchmark" /></>}

      <h3>Tiefste Rückgänge</h3>
      <Episodes a={data.depot} />

      <h3>Spannen</h3>
      <ul className="plain-list" data-testid="ranges">
        {data.depot.ranges.map((r) => (
          <li key={r.days} className="num">
            Nach {r.days} Handelstagen im Plus: {r.positiveShare === null ? <span className="muted">noch zu wenig Fenster ({r.windows}, nötig 30)</span> : <><strong>{formatPercentPlain(r.positiveShare)}</strong> <span className="muted">von {r.windows} Fenstern</span></>}
          </li>
        ))}
      </ul>
      <p className="muted">Beobachtung am bisherigen Verlauf, keine Prognose.</p>
    </section>
  );
}
