import { useCallback, useEffect, useRef, useState } from "react";
import { getArchiveInfo, getCoverage, getDataStatus, getFlags, getGaps, getJobs, getSources, runJob } from "../api.js";
import { CALL_COLUMNS, LIGHT_WORD, STATE_WORD, ago, dayLong, formatBytes, until, utcTime } from "../data.js";
import { CoverageGrid } from "./CoverageGrid.js";
import type { ArchiveInfo, Coverage, DataStatus, FlagReport, GapReport, JobsOverview, SourceSummary } from "../types.js";

const REFRESH_MS = 15_000;
const de = (n: number) => n.toLocaleString("de-DE");

interface Props {
  /** Called when the status line should read the light again (a job was started). */
  onChanged?: () => void;
  /** Without a simulation there are no tabs to go back with. */
  onClose?: () => void;
}

const READING_AID = [
  ["grün", "Alle Handelstage der letzten 29 Tage sind geladen, die Quelle hat nicht gedrosselt, die Sammlung läuft."],
  ["gelb", "Es gibt Lücken (Tage nie geladen, abgebrochen oder leer), die Quelle hat in den letzten 24 Stunden mit 429 abgelehnt, oder ein Lauf ist fehlgeschlagen. Meist hilft Abwarten: die nächtliche Lückenreparatur holt nach."],
  ["rot", "Der letzte erfolgreiche Sammellauf ist älter als 2 Tage. Unter „Aufträge“ den Fehler lesen, dann „Jetzt ausführen“."],
] as const;

/** The state of the archive and of the sources: grid of loaded days, gaps in a day, source counters, job log, size. */
export function DataView({ onChanged, onClose }: Props) {
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [archive, setArchive] = useState<ArchiveInfo | null>(null);
  const [jobs, setJobs] = useState<JobsOverview | null>(null);
  const [flags, setFlags] = useState<FlagReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ symbol: string; day: string } | null>(null);
  const [gaps, setGaps] = useState<GapReport | null>(null);
  const [gapError, setGapError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  const nowS = Date.now() / 1000;

  const load = useCallback(async () => {
    try {
      const [st, cov, src, arc, jb, fl] = await Promise.all([getDataStatus(), getCoverage(30), getSources(), getArchiveInfo(), getJobs(), getFlags()]);
      if (!alive.current) return;
      setStatus(st); setCoverage(cov); setSources(src); setArchive(arc); setJobs(jb); setFlags(fl);
      setError(null);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load]);

  useEffect(() => {
    setGaps(null);
    setGapError(null);
    if (!picked) return;
    let current = true;
    getGaps(picked.symbol, picked.day)
      .then((g) => current && setGaps(g))
      .catch((e: Error) => current && setGapError(e.message));
    return () => { current = false; };
  }, [picked]);

  async function start(name: string) {
    setMessage(null);
    try {
      await runJob(name);
      setMessage("Der Auftrag ist eingeplant und läuft im Hintergrund.");
      onChanged?.();
      setTimeout(() => void load(), 600);
    } catch (e) {
      setMessage((e as Error).message);
    }
  }

  return (
    <div className="stack data-view" data-testid="data-view">
      {onClose && <button className="btn small" onClick={onClose}>Schließen</button>}
      {error && <p className="banner error" role="alert">{error}</p>}

      <section className="card" aria-label="Ampel">
        <h2>Datenzustand</h2>
        {status ? (
          <>
            <p className="light-line" data-testid="data-light" data-level={status.level}>
              <span className={`light ${status.level}`} aria-hidden="true" />
              <strong>Ampel: {LIGHT_WORD[status.level]}</strong>
            </p>
            <ul className="reasons">
              {status.reasons.length === 0 && <li className="muted">Nichts auffällig.</li>}
              {status.reasons.map((r, i) => <li key={i} className={r.level === "info" ? "muted" : undefined}>{r.text}</li>)}
            </ul>
          </>
        ) : <p className="muted">Lädt …</p>}
        <details>
          <summary>Lesehilfe</summary>
          <dl className="aid">{READING_AID.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        </details>
      </section>

      <section className="card" aria-label="Abdeckung">
        <h2>Abdeckung der letzten 30 Tage</h2>
        {coverage ? (
          <>
            <CoverageGrid coverage={coverage} picked={picked} onPick={setPicked} />
            <ul className="legend-cov" aria-label="Legende">
              {(["complete", "partial", "never", "empty", "closed"] as const).map((s) => (
                <li key={s}><span className={`cell ${s}`} aria-hidden="true" /> {STATE_WORD[s]}</li>
              ))}
              <li><span className="cell complete thin" aria-hidden="true" /> dünn gehandelt (Hinweis)</li>
            </ul>
            <p className="muted small-text">
              Unvollständig oder nie geladen zählt nur für abgeschlossene Handelstage der letzten {coverage.reachDays} Tage; Yahoo liefert Minutenbalken nicht weiter zurück.
              Ein Zellenklick zeigt die Minuten ohne Balken.
            </p>
          </>
        ) : <p className="muted">Lädt …</p>}
      </section>

      {picked && (
        <section className="card" aria-label="Lücken im Tag" data-testid="gap-card">
          <h2>{picked.symbol} am {dayLong(picked.day)}</h2>
          {gapError && <p className="banner error" role="alert">{gapError}</p>}
          {!gaps && !gapError && <p className="muted">Lädt …</p>}
          {gaps && !gaps.open && <p>Die Börse war geschlossen ({gaps.reason}). Es wird nichts erwartet.</p>}
          {gaps && gaps.open && (
            <>
              <p data-testid="gap-summary">
                {gaps.windowFrom === null ? "Für diesen Tag gibt es keine Balken." : (
                  <>{de(gaps.bars)} von {de(gaps.expected)} Minuten mit Balken ({utcTime(gaps.windowFrom)}–{utcTime(gaps.windowTo!)} UTC), {de(gaps.missingMinutes)} ohne.</>
                )}
              </p>
              <p className="muted">{gaps.hint}</p>
              {gaps.gaps.length > 0 && (
                <div className="table-wrap">
                  <table data-testid="gap-list">
                    <thead><tr><th>von (UTC)</th><th>bis (UTC)</th><th className="num">Minuten</th></tr></thead>
                    <tbody>
                      {gaps.gaps.map((g) => (
                        <tr key={g.from}><td className="num">{utcTime(g.from)}</td><td className="num">{utcTime(g.to)}</td><td className="num">{de(g.minutes)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {gaps.truncated && <p className="muted">Die Liste ist gekürzt.</p>}
            </>
          )}
        </section>
      )}

      <section className="card" aria-label="Quellenstatus">
        <h2>Quellen, letzte 24 Stunden</h2>
        {sources ? (
          <div className="table-wrap">
            <table data-testid="source-table">
              <thead>
                <tr>
                  <th>Quelle</th>
                  {CALL_COLUMNS.map((c) => <th key={c.kind} className="num" title={c.hint}>{c.label}</th>)}
                  <th className="num">Ø Antwort</th>
                  <th>Letzter Erfolg</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.source} data-testid={`source-${s.source}`}>
                    <td>{s.label}</td>
                    {CALL_COLUMNS.map((c) => (
                      <td key={c.kind} className={`num${c.kind === "429" && s.counts[c.kind] > 0 ? " warn" : ""}`} data-kind={c.kind}>{de(s.counts[c.kind])}</td>
                    ))}
                    <td className="num">{s.meanMs === null ? "–" : `${de(s.meanMs)} ms`}</td>
                    <td>{ago(s.lastOkAt, nowS)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">Lädt …</p>}
        <p className="muted small-text">
          404 heißt „leere Antwort“ (Feiertag, Tag ohne Handel) und ist kein Fehler. Die Zähler sind seit dem Serverstart nicht verloren, sie liegen in der Datenbank. Die Suche zählt auch Antworten aus ihrem Zwischenspeicher.
        </p>
      </section>

      <section className="card" aria-label="Aufträge">
        <h2>Aufträge</h2>
        {message && <p className="banner" role="status">{message}</p>}
        {jobs ? (
          <>
            {!jobs.enabled && <p className="muted">Der Planer ist aus (JOBS=off). Aufträge laufen nur auf Knopfdruck.</p>}
            <div className="table-wrap">
              <table data-testid="job-table">
                <thead><tr><th>Auftrag</th><th className="col-plan">Plan</th><th>Nächster Lauf</th><th>Letzter Lauf</th><th /></tr></thead>
                <tbody>
                  {jobs.jobs.map((j) => (
                    <tr key={j.name} data-testid={`job-${j.name}`}>
                      <td>{j.label}</td>
                      <td className="col-plan">{j.schedule}</td>
                      <td>{j.running ? "läuft" : j.queued ? "wartet" : until(j.nextAt, nowS)}</td>
                      <td>{j.lastRun ? `${j.lastRun.label}, ${ago(j.lastRun.startedAt, nowS)}` : "–"}</td>
                      <td><button className="btn small" data-testid={`run-${j.name}`} disabled={j.running || j.queued} onClick={() => void start(j.name)}>Jetzt ausführen</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Protokoll</h3>
            <div className="table-wrap">
              <table data-testid="run-log">
                <thead><tr><th>Zeit</th><th>Auftrag</th><th>Ergebnis</th></tr></thead>
                <tbody>
                  {jobs.runs.length === 0 && <tr><td colSpan={3} className="muted">Noch kein Lauf.</td></tr>}
                  {jobs.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="num">{new Date(r.startedAt * 1000).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</td>
                      <td>{r.job === "ampel" ? "Ampel" : (jobs.jobs.find((j) => j.name === r.job)?.label ?? r.job)}{r.trigger === "hand" ? " (von Hand)" : ""}</td>
                      <td><strong>{r.label}.</strong> {r.error ?? r.message ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : <p className="muted">Lädt …</p>}
      </section>

      <section className="card" aria-label="Kurskontrolle">
        <h2>Kurskontrolle</h2>
        {flags ? (
          flags.bySymbol.length === 0 ? <p className="muted" data-testid="flags-none">Keine auffälligen Balken.</p> : (
            <>
              <p className="muted">
                Verdächtige Balken werden markiert, nie gelöscht oder geändert. Ausreißer sind in der Simulation nicht handelbar und im Chart hohl.
                Anteil der Ausreißer an allen Minutenbalken: <span className="num">{(flags.spikeShare * 100).toLocaleString("de-DE", { maximumFractionDigits: 4 })} %</span>.
              </p>
              <dl className="facts" data-testid="flag-counts">
                <div><dt>Ausreißer</dt><dd className="num">{de(flags.counts.spike)}</dd></div>
                <div><dt>Abweichung vom Tagesschluss</dt><dd className="num">{de(flags.counts.daily)}</dd></div>
                <div><dt>Strukturfehler (nicht gespeichert)</dt><dd className="num">{de(flags.counts.struct)}</dd></div>
                <div><dt>Doppelte oder rückwärtige Minuten</dt><dd className="num">{de(flags.counts.dup + flags.counts.time)}</dd></div>
              </dl>
              <div className="table-wrap">
                <table data-testid="flag-table">
                  <caption className="muted">Neueste Markierungen{flags.truncated ? " (die ersten 500)" : ""}</caption>
                  <thead><tr><th>Wert</th><th>Zeit (UTC)</th><th>Art</th><th>Einzelheit</th></tr></thead>
                  <tbody>
                    {flags.flags.slice(0, 50).map((f) => (
                      <tr key={`${f.symbol}|${f.t}|${f.kind}`}><td>{f.symbol}</td><td className="num">{new Date(f.t * 1000).toISOString().slice(0, 16).replace("T", " ")}</td><td>{f.label}</td><td>{f.detail}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : <p className="muted">Lädt …</p>}
      </section>

      <section className="card" aria-label="Archiv">
        <h2>Archiv</h2>
        {archive ? (
          <>
            <dl className="facts" data-testid="archive-facts">
              <div><dt>Minutenbalken</dt><dd className="num">{de(archive.rows.bars)}</dd></div>
              <div><dt>Tagesbalken</dt><dd className="num">{de(archive.rows.dailyBars)}</dd></div>
              <div><dt>Geladene Tage</dt><dd className="num">{de(archive.rows.fetchedDays)}</dd></div>
              <div><dt>Datenbankdatei</dt><dd className="num">{formatBytes(archive.fileBytes)}</dd></div>
              <div><dt>Letzte Sicherung</dt><dd>{archive.backupEnabled ? ago(archive.lastBackupAt, nowS) : "keine Tagessicherung eingestellt"}</dd></div>
            </dl>
            {archive.weeks.length > 0 && (
              <div className="table-wrap">
                <table data-testid="growth-table">
                  <caption className="muted">Wachstum je Woche (nach dem Datum der Balken, Größe geschätzt)</caption>
                  <thead><tr><th>Woche ab</th><th className="num">Balken</th><th className="num">ca.</th></tr></thead>
                  <tbody>
                    {archive.weeks.map((w) => (
                      <tr key={w.weekStart}><td>{dayLong(w.weekStart)}</td><td className="num">{de(w.bars)}</td><td className="num">{formatBytes(w.estimatedBytes)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : <p className="muted">Lädt …</p>}
      </section>
    </div>
  );
}
