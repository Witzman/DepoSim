import { useEffect, useState } from "react";
import { getDividends } from "../api.js";
import { formatEur, formatPercentPlain, formatPrice, signedPercent } from "../format.js";
import type { DepotView, DividendCalendar } from "../types.js";

const REFRESH_MS = 5000;
const KEY = "deposim.withholding";

/** Withholding tax shown as information only: nothing in the depot is reduced by it (the tax work is #39). */
const WITHHOLDING = [
  { id: "0", label: "ohne", rate: 0 },
  { id: "15", label: "15 % (US)", rate: 0.15 },
  { id: "26375", label: "26,375 % (Inland)", rate: 0.26375 },
] as const;

const storedRate = (): string => {
  try {
    const v = localStorage.getItem(KEY);
    return WITHHOLDING.some((w) => w.id === v) ? (v as string) : "0";
  } catch {
    return "0";
  }
};

const MONTH = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", month: "long", year: "numeric" });
const monthName = (m: string) => MONTH.format(Date.parse(`${m}-01T00:00:00Z`));
const dayText = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

interface Props {
  simulationId: number;
  depot: DepotView;
  running: boolean;
}

/** Distributions of the titles of a depot: the last payments, yields, and the income by month and year. */
export function Dividends({ simulationId, depot, running }: Props) {
  const [data, setData] = useState<DividendCalendar | null>(null);
  const [failed, setFailed] = useState(false);
  const [taxId, setTaxId] = useState(storedRate);
  const credited = depot.positions.length + depot.orders.filter((o) => o.status === "filled").length;

  useEffect(() => {
    let alive = true;
    const load = () => getDividends(simulationId, depot.id).then((d) => { if (alive) { setData(d); setFailed(false); } }).catch(() => { if (alive) setFailed(true); });
    load();
    const timer = running ? setInterval(load, REFRESH_MS) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [simulationId, depot.id, running, credited]);

  const rate = WITHHOLDING.find((w) => w.id === taxId)?.rate ?? 0;
  const net = (cent: number) => Math.round(cent * (1 - rate));

  function chooseTax(id: string) {
    setTaxId(id);
    try { localStorage.setItem(KEY, id); } catch { /* the choice is kept for this visit only */ }
  }

  if (failed && !data) return <section className="card" data-testid="dividends"><h2>Dividenden</h2><p className="muted" role="status">Die Ausschüttungen konnten nicht gelesen werden.</p></section>;
  if (!data) return null;
  const { income, returnSplit } = data;
  const noTitles = data.lines.length === 0;

  return (
    <section className="card dividends" aria-label="Dividenden" data-testid="dividends">
      <div className="toolbar">
        <h2>Dividenden</h2>
        <label className="inline">Quellensteuer (nur Anzeige)
          <select value={taxId} onChange={(e) => chooseTax(e.target.value)} data-testid="withholding">
            {WITHHOLDING.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </label>
      </div>
      {rate > 0 && <p className="muted" role="note">Die Beträge unten zeigen, was nach {formatPercentPlain(rate)} Quellensteuer bliebe. Im Depot wird brutto gebucht.</p>}

      <h3>Einnahmen</h3>
      {income.count === 0 ? <p className="muted" data-testid="income-empty">Noch keine Ausschüttung gebucht.</p> : (
        <div data-testid="income">
          <p className="num"><strong data-testid="income-total">{formatEur(net(income.total))}</strong> aus {income.count} {income.count === 1 ? "Ausschüttung" : "Ausschüttungen"}</p>
          <table className="plain">
            <thead><tr><th scope="col">Jahr</th><th scope="col" className="num">Summe</th></tr></thead>
            <tbody>{income.byYear.map((y) => <tr key={y.year}><td>{y.year}</td><td className="num">{formatEur(net(y.amount))}</td></tr>)}</tbody>
          </table>
          <details>
            <summary>Je Monat</summary>
            <ul className="plain-list">{income.byMonth.map((m) => <li key={m.month}>{monthName(m.month)} <span className="num">{formatEur(net(m.amount))}</span></li>)}</ul>
          </details>
          <p className="muted num" data-testid="return-split">
            Rendite aus Ausschüttungen {signedPercent(returnSplit.fromDistributions)}
            {returnSplit.fromPrice !== null && <> · aus dem Kurs {signedPercent(returnSplit.fromPrice)}</>}
            {returnSplit.total !== null && <> · zusammen {signedPercent(returnSplit.total)}</>}
          </p>
        </div>
      )}

      <h3>Kalender</h3>
      {noTitles ? <p className="muted">Das Depot hält keinen Titel und hat keine Ausschüttung erhalten.</p> : (
        <ul className="div-lines">
          {data.lines.map((l) => (
            <li key={l.symbol} data-testid={`div-${l.symbol}`}>
              <div className="row"><strong>{l.symbol}</strong> <span className="muted">{l.name}{l.qty > 0 ? ` · ${l.qty} Stück` : " · nicht mehr im Depot"}</span></div>
              {!l.known ? (
                <p className="muted" data-testid={`div-none-${l.symbol}`}>Keine Ausschüttungsdaten. Die Quelle kennt für diesen Titel keine Zahlung oder wurde noch nicht gefragt.</p>
              ) : (
                <>
                  <p className="muted num">
                    Letzte 12 Monate {l.last12mPerShare === null ? "—" : formatEur(Math.round(l.last12mPerShare * 100))} je Stück
                    {" · "}Dividendenrendite {formatPercentPlain(l.yield12m)}
                    {l.yieldOnCost !== null && <> · auf Einstand {formatPercentPlain(l.yieldOnCost)}</>}
                    {l.expectedYear !== null && <> · bei gleichem Muster etwa {formatEur(net(l.expectedYear))} im Jahr</>}
                  </p>
                  {l.pattern && <p className="muted">{l.pattern}</p>}
                  <ul className="div-past">
                    {l.past.map((p) => (
                      <li key={p.exDay} className="num">
                        Ex-Tag {dayText(p.exDay)}: {formatPrice(p.perShare, p.currency)} je Stück
                        {p.credited !== null ? <> · gutgeschrieben {formatEur(net(p.credited))}</> : <> · nicht gehalten</>}
                        <span className="muted"> · Quelle {p.source}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">{data.note} Zahltag ist der Ex-Tag, Beträge brutto.</p>
    </section>
  );
}
