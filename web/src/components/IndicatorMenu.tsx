import { useState } from "react";
import type { IndicatorPrefs, IndicatorParams } from "../indicatorPrefs.js";
import type { IndicatorId } from "../indicators.js";

interface Field { key: string; label: string; step?: number }
const ROWS: { id: IndicatorId; label: string; fields: Field[] }[] = [
  { id: "sma", label: "SMA", fields: [{ key: "period", label: "Periode" }] },
  { id: "ema", label: "EMA", fields: [{ key: "period", label: "Periode" }] },
  { id: "bollinger", label: "Bollinger", fields: [{ key: "period", label: "Periode" }, { key: "k", label: "Faktor", step: 0.5 }] },
  { id: "vwap", label: "VWAP (Tag)", fields: [] },
  { id: "rsi", label: "RSI", fields: [{ key: "period", label: "Periode" }] },
  { id: "macd", label: "MACD", fields: [
    { key: "fast", label: "schnell" }, { key: "slow", label: "langsam" }, { key: "signal", label: "Signal" },
  ] },
  { id: "stoch", label: "Stochastik", fields: [{ key: "k", label: "%K" }, { key: "d", label: "%D" }] },
  { id: "atr", label: "ATR", fields: [{ key: "period", label: "Periode" }] },
  { id: "obv", label: "OBV", fields: [] },
];

interface Props {
  prefs: IndicatorPrefs;
  onChange: (p: IndicatorPrefs) => void;
}

export function IndicatorMenu({ prefs, onChange }: Props) {
  const toggle = (id: IndicatorId, on: boolean) =>
    onChange({ ...prefs, enabled: on ? [...prefs.enabled, id] : prefs.enabled.filter((x) => x !== id) });
  const [problem, setProblem] = useState<string | null>(null);
  const setParam = (id: IndicatorId, key: string, label: string, value: number) => {
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      setProblem(`${label}: ganze Zahl von 1 bis 500 eingeben. Der alte Wert bleibt.`);
      return;
    }
    setProblem(null);
    onChange({ ...prefs, params: { ...prefs.params, [id]: { ...prefs.params[id], [key]: value } } as IndicatorParams });
  };
  return (
    <details className="ind-menu" data-guide="indicators">
      <summary className="btn small">Indikatoren</summary>
      <div className="ind-list">
        {ROWS.map((r) => (
          <div key={r.id} className="ind-row">
            <label>
              <input type="checkbox" aria-label={r.label} checked={prefs.enabled.includes(r.id)}
                onChange={(e) => toggle(r.id, e.target.checked)} /> {r.label}
            </label>
            {r.fields.map((f) => (
              <input key={f.key} type="number" className="ind-param" min={1} max={500} step={f.step ?? 1}
                aria-label={`${r.label} ${f.label}`} title={f.label}
                value={(prefs.params[r.id] as Record<string, number>)[f.key]}
                aria-invalid={problem !== null && problem.startsWith(`${r.label} ${f.label}:`)}
                onChange={(e) => setParam(r.id, f.key, `${r.label} ${f.label}`, e.target.valueAsNumber)} />
            ))}
          </div>
        ))}
      </div>
      {problem && <p className="error" role="alert" data-testid="ind-problem">{problem}</p>}
    </details>
  );
}
