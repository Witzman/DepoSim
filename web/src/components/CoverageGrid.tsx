import { cellLabel, dayShort } from "../data.js";
import type { Coverage } from "../types.js";

interface Props {
  coverage: Coverage;
  picked: { symbol: string; day: string } | null;
  onPick: (p: { symbol: string; day: string }) => void;
}

/** The grid value x day: one small button per cell. State is shown by fill and outline, not by colour alone. */
export function CoverageGrid({ coverage, picked, onPick }: Props) {
  return (
    <div className="cov" role="grid" aria-label="Raster Wert mal Tag" data-testid="coverage-grid"
      style={{ gridTemplateColumns: `minmax(64px, 96px) repeat(${coverage.days.length}, minmax(0, 1fr))` }}>
      <div className="cov-head" aria-hidden="true" />
      {coverage.days.map((d, i) => (
        <div key={d} className="cov-day" aria-hidden="true">{i % 7 === 0 && i < coverage.days.length - 3 ? dayShort(d).slice(0, 5) : ""}</div>
      ))}
      {coverage.rows.map((row) => (
        <div className="cov-row" role="row" key={row.symbol} style={{ display: "contents" }}>
          <div className="cov-name" role="rowheader" title={row.name}>{row.symbol === "EURUSD=X" ? "EUR/USD" : row.symbol}</div>
          {row.cells.map((c) => (
            <button key={c.day} role="gridcell" type="button"
              className={`cell ${c.state}${c.thin ? " thin" : ""}${c.today ? " today" : ""}${picked?.symbol === row.symbol && picked.day === c.day ? " picked" : ""}`}
              data-testid={`cell-${row.symbol}-${c.day}`} data-state={c.state}
              aria-label={cellLabel(row.symbol, c)} title={cellLabel(row.symbol, c)}
              onClick={() => onPick({ symbol: row.symbol, day: c.day })} />
          ))}
        </div>
      ))}
    </div>
  );
}
