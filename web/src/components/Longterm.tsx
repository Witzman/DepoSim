import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getLongterm, getLongtermRefresh, startLongtermRefresh } from "../api.js";
import { arrowOf, formatEur, signedPercent } from "../format.js";
import type { Theme } from "../theme.js";
import type { Longterm as LongtermData, LongtermJob } from "../types.js";

const POLL_MS = 700;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// Not colour alone: each line also has its own dash pattern, and the legend repeats it.
const STYLES = [LineStyle.Solid, LineStyle.LargeDashed, LineStyle.Dotted] as const;
const SWATCH = ["solid", "dashed", "dotted"] as const;
const euro = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const dayFormat = (day: string) => day.split("-").reverse().join(".");

const ASSUMPTIONS = [
  "Das ist eine Rechnung mit Tageskursen, keine Simulation: keine Uhr, keine Orders, kein Orderbuch.",
  "Datenquelle: Yahoo Finance, Tageskurse und Ausschüttungen (inoffiziell, kostenlos). Yahoo nennt nur den Ex-Tag; der Zahltag wird dem Ex-Tag gleichgesetzt (Annahme).",
  "Erster Kauf zum Eröffnungskurs des ersten Handelstags ab 01.11.2019; jede Wiederanlage zum Eröffnungskurs des nächsten Handelstags nach dem Ex-Tag.",
  "Gebühren wie im Rest der App (Provision mit Mindestbetrag, Spread); ganze Stücke, der Rest bleibt als Guthaben und wird bei der nächsten Wiederanlage mitgenommen. Eine Ausschüttung, die nach Gebühren kein ganzes Stück ergibt, bleibt Guthaben.",
  "Keine Steuern (Quellensteuer, Abgeltungsteuer, Vorabpauschale): die Ausschüttungen werden brutto angelegt.",
  "Ausschüttende ETFs an der Xetra in Euro; die Kurse sind die Rohkurse von Yahoo ohne Dividendenbereinigung. Tage, an denen Yahoo keinen Kurs liefert, fehlen auch hier.",
  "Historische Rechnung, kein Ratschlag und keine Prognose.",
];

interface Props {
  theme: Theme;
}

export function Longterm({ theme }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const lines = useRef(new Map<string, ISeriesApi<"Line">>());
  const [data, setData] = useState<LongtermData | null>(null);
  const [job, setJob] = useState<LongtermJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getLongterm());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // While a job runs, ask for its state until it is over; then read the result.
  useEffect(() => {
    if (!polling) return;
    let current = true;
    const timer = setInterval(async () => {
      try {
        const j = await getLongtermRefresh();
        if (!current) return;
        setJob(j);
        if (!j.running) {
          setPolling(false);
          await load();
        }
      } catch (e) {
        if (current) { setError((e as Error).message); setPolling(false); }
      }
    }, POLL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [polling, load]);

  async function refresh() {
    setError(null);
    try {
      setJob(await startLongtermRefresh());
    } catch (e) {
      // 409: a job already runs. Follow it instead of refusing.
      setError((e as Error).message);
    }
    setPolling(true);
  }

  useEffect(() => {
    const api = createChart(host.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--surface") }, textColor: css("--muted") },
      grid: { vertLines: { color: css("--border") }, horzLines: { color: css("--border") } },
      rightPriceScale: { borderColor: css("--border") },
      timeScale: { borderColor: css("--border") },
      localization: { dateFormat: "dd.MM.yyyy", priceFormatter: (p: number) => `${euro.format(p)} €` },
    });
    chart.current = api;
    const map = lines.current;
    return () => {
      api.remove();
      chart.current = null;
      map.clear();
    };
  }, []);

  useEffect(() => {
    const api = chart.current;
    if (!api) return;
    const c = { surface: css("--surface"), muted: css("--muted"), border: css("--border") };
    api.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.muted },
      grid: { vertLines: { color: c.border }, horzLines: { color: c.border } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    const depots = data && data.ready ? data.depots : [];
    depots.forEach((d, i) => {
      let series = lines.current.get(d.key);
      if (!series) {
        series = api.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false });
        lines.current.set(d.key, series);
      }
      series.applyOptions({ color: css(`--series-${i + 1}`), lineStyle: STYLES[i % STYLES.length] });
      series.setData(d.curve.map(([day, cent]) => ({ time: day, value: cent / 100 })));
    });
    if (depots.length) api.timeScale().fitContent();
  }, [data, theme]);

  const ready = data && data.ready ? data : null;
  const running = job?.running ?? false;

  return (
    <section className="card" aria-label="Langzeitvergleich" data-testid="longterm">
      <div className="toolbar">
        <h2>Langzeitvergleich</h2>
        <button className="btn" onClick={() => void refresh()} disabled={running} data-testid="longterm-refresh">Daten laden</button>
      </div>
      <p className="muted">
        Drei Depots mit je {ready ? formatEur(ready.startCash) : "40.000,00 €"}, einmal angelegt am 01.11.2019, alle Ausschüttungen
        wieder angelegt. Rechnung mit Tageskursen, keine Simulation.
      </p>

      <div className="banner" data-testid="longterm-assumptions" role="note">
        <strong>Annahmen</strong>
        <ul>{ASSUMPTIONS.map((a) => <li key={a}>{a}</li>)}</ul>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {job && (running || job.items.length > 0) && (
        <p role="status" data-testid="longterm-job">
          {running ? `Lade Daten … ${job.done} von ${job.total}` : job.stoppedByRateLimit
            ? "Yahoo hat mit 429 abgelehnt; der Rest wurde nicht geladen. Später noch einmal versuchen."
            : job.error ?? `Fertig: ${job.items.map((i) => `${i.symbol} ${i.label}`).join(", ")}.`}
        </p>
      )}
      {data && !data.ready && (
        <p className="muted" data-testid="longterm-missing">
          Noch keine Daten für {data.missing.map((m) => `${m.symbol} (${m.reason})`).join(", ")}. „Daten laden“ holt sie einmal von Yahoo
          und legt sie ab.
        </p>
      )}

      <div className="chart curves" data-testid="longterm-chart" data-series={ready ? ready.depots.length : 0} ref={host} />
      {ready && (
        <>
          <ul className="legend" aria-label="Legende" data-testid="longterm-legend">
            {ready.depots.map((d, i) => (
              <li key={d.key}>
                <span className="swatch" style={{ borderTopColor: css(`--series-${i + 1}`), borderTopStyle: SWATCH[i % SWATCH.length] }} aria-hidden="true" />
                <span>{d.index} ({d.symbol})</span>
              </li>
            ))}
          </ul>
          <p className="muted">
            Stand {dayFormat(ready.depots[0].totals.lastDay ?? ready.startDay)}; Wert = Stücke × Schlusskurs + Guthaben.
          </p>
          <div className="scroll">
            <table className="positions num stacked" data-testid="longterm-table">
              <thead>
                <tr>
                  <th>ETF</th><th>Endwert</th><th>Rendite</th><th>Ausschüttungen</th><th>Wiederanlagen</th>
                  <th>Gebühren</th><th>davon Spread</th><th>Guthaben</th><th>Stücke</th>
                </tr>
              </thead>
              <tbody>
                {ready.depots.map((d) => {
                  const t = d.totals;
                  const cls = t.totalReturn > 0 ? "up" : t.totalReturn < 0 ? "down" : "muted";
                  return (
                    <tr key={d.key} data-testid={`longterm-row-${d.key}`}>
                      <td>{d.index} · {d.symbol}</td>
                      <td data-label="Endwert">{formatEur(t.finalValue)}</td>
                      <td data-label="Rendite"><span className={cls}>{arrowOf(t.totalReturn)} {signedPercent(t.totalReturn)}</span></td>
                      <td data-label="Ausschüttungen">{formatEur(t.dividendsReceived)}</td>
                      <td data-label="Wiederanlagen">{t.reinvestments}{t.skippedReinvestments > 0 ? ` (${t.skippedReinvestments} ohne Kauf)` : ""}</td>
                      <td data-label="Gebühren">{formatEur(t.feesPaid)}</td>
                      <td data-label="davon Spread">{formatEur(t.spreadPaid)}</td>
                      <td data-label="Guthaben">{formatEur(t.leftoverCash)}</td>
                      <td data-label="Stücke">{t.shares}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted">Gebühren: Provision aller Käufe, der erste eingeschlossen. Der Spread steckt schon im Kaufkurs und ist hier nur zur Ansicht ausgewiesen.</p>
        </>
      )}
    </section>
  );
}
