import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoverageGrid } from "../src/components/CoverageGrid.js";
import { ago, cellLabel, formatBytes, lightLine, until } from "../src/data.js";
import type { Coverage, DataCell, DataStatus } from "../src/types.js";
import { createElement } from "react";

const cell = (day: string, over: Partial<DataCell> = {}): DataCell =>
  ({ day, state: "complete", bars: 510, expected: 510, thin: false, today: false, ...over });

const coverage: Coverage = {
  days: ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"],
  reachDays: 29,
  gapCells: 1,
  rows: [
    {
      symbol: "SAP.DE", name: "SAP", venue: "XETRA", kind: "EQUITY",
      cells: [cell("2026-10-21", { state: "never", bars: 0 }), cell("2026-10-22"), cell("2026-10-23", { state: "partial", bars: 30, today: true }),
        cell("2026-10-24", { state: "closed", bars: 0, expected: null, reason: "Wochenende" })],
    },
    {
      symbol: "EXS1.DE", name: "iShares Core DAX", venue: "XETRA", kind: "ETF",
      cells: [cell("2026-10-21", { bars: 108, thin: true }), cell("2026-10-22", { state: "empty", bars: 0 }), cell("2026-10-23"), cell("2026-10-24", { state: "closed", bars: 0, expected: null, reason: "Wochenende" })],
    },
  ],
};

const html = (picked: { symbol: string; day: string } | null = null) =>
  renderToStaticMarkup(createElement(CoverageGrid, { coverage, picked, onPick: () => {} }));

describe("CoverageGrid", () => {
  it("draws one cell per symbol and day with the state of the server", () => {
    const out = html();
    expect(out.match(/<button/g)).toHaveLength(8);
    expect(out).toContain('data-testid="cell-SAP.DE-2026-10-21" data-state="never"');
    expect(out).toContain('data-testid="cell-SAP.DE-2026-10-22" data-state="complete"');
    expect(out).toContain('data-testid="cell-SAP.DE-2026-10-23" data-state="partial"');
    expect(out).toContain('data-testid="cell-EXS1.DE-2026-10-22" data-state="empty"');
    expect(out).toContain('data-state="closed"');
  });

  it("gives every cell a text for screen readers and the tooltip, with bars and expectation", () => {
    const out = html();
    expect(out).toContain('aria-label="SAP.DE, 22.10.2026: vollständig, 510 von 510 Balken erwartet"');
    expect(out).toContain("EXS1.DE, 21.10.2026: vollständig, 108 von 510 Balken erwartet, dünn gehandelt, das ist kein Fehler");
    expect(out).toContain("SAP.DE, 24.10.2026: Wochenende");
  });

  it("marks thin days and today, and the picked cell", () => {
    const out = html({ symbol: "SAP.DE", day: "2026-10-22" });
    expect(out).toMatch(/class="cell complete thin"[^>]*data-testid="cell-EXS1.DE-2026-10-21"/);
    expect(out).toMatch(/class="cell partial today"/);
    expect(out).toMatch(/class="cell complete picked"[^>]*data-testid="cell-SAP.DE-2026-10-22"/);
  });
});

describe("cellLabel", () => {
  it("says a running day is not over, and omits the bars of a closed day", () => {
    expect(cellLabel("SAP.DE", cell("2026-10-23", { state: "partial", bars: 30, today: true })))
      .toBe("SAP.DE, 23.10.2026: unvollständig, 30 von 510 Balken erwartet, der Tag läuft noch");
    expect(cellLabel("SAP.DE", cell("2026-04-03", { state: "closed", bars: 0, expected: null, reason: "Feiertag: Karfreitag" })))
      .toBe("SAP.DE, 03.04.2026: Feiertag: Karfreitag");
  });
});

describe("lightLine", () => {
  const status = (over: Partial<DataStatus>): DataStatus =>
    ({ level: "green", reasons: [], lastCollectionAt: null, gapCells: 0, rateLimited24h: 0, ...over });
  it("names the light and lists the reasons that are not just information", () => {
    expect(lightLine(status({}))).toEqual({ text: "Daten: grün", title: "Daten in Ordnung." });
    const y = lightLine(status({ level: "yellow", reasons: [{ level: "info", text: "Planer aus." }, { level: "yellow", text: "429" }] }));
    expect(y).toEqual({ text: "Daten: gelb", title: "429" });
    expect(lightLine(status({ level: "red" })).text).toBe("Daten: rot");
  });
});

describe("times and sizes", () => {
  it("says how long ago and how long until", () => {
    expect(ago(null, 1000)).toBe("nie");
    expect(ago(1000, 1030)).toBe("gerade eben");
    expect(ago(1000, 1000 + 600)).toBe("vor 10 Min.");
    expect(ago(1000, 1000 + 5 * 3600)).toBe("vor 5 Std.");
    expect(ago(1000, 1000 + 3 * 86400)).toBe("vor 3 Tagen");
    expect(until(null, 0)).toBe("aus");
    expect(until(3 * 3600, 0)).toBe("in 3 Std.");
  });
  it("writes sizes in German", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(5.5 * 1024 ** 2)).toBe("5,5 MB");
  });
});
