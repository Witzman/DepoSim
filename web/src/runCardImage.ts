import { formatEur, formatPercentPlain, signedPercent } from "./format.js";
import { PRESET_LABEL } from "./rules.js";
import { starText } from "./scenarioStars.js";
import { formatSimTime } from "./time.js";
import type { RunSummary } from "./types.js";

export const CARD_W = 1200;
export const CARD_H = 630;

/** The card is an image that leaves the app, so it has its own light colours and does not follow the theme. */
const C = { bg: "#ffffff", ink: "#111723", muted: "#5a6577", line: "#d7dde6", depot: "#1f5fe0", bench: "#d4731f", up: "#0a7a54", down: "#c0392b" };
const GRADE_COLOR = { A: "#0a7a54", B: "#4a8f2a", C: "#b58a00", D: "#c9661a", E: "#c0392b" } as const;

type Ctx = CanvasRenderingContext2D;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Both lines on one scale, each rebased to 100 at its first point, so a depot and a price can be compared. */
export function rebase(points: { t: number; value: number }[]): { t: number; v: number }[] {
  const first = points[0]?.value;
  if (!first) return [];
  return points.map((p) => ({ t: p.t, v: (p.value / first) * 100 }));
}

function drawCurve(ctx: Ctx, run: RunSummary, x: number, y: number, w: number, h: number) {
  const depot = rebase(run.curve.depot);
  const bench = run.curve.benchmark ? rebase(run.curve.benchmark) : [];
  const all = [...depot, ...bench];
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  if (depot.length < 2) {
    ctx.fillStyle = C.muted;
    ctx.font = `20px ${FONT}`;
    ctx.fillText("Zu wenige Punkte für eine Kurve", x + 24, y + h / 2);
    return;
  }
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const lo = Math.min(...all.map((p) => p.v), 100);
  const hi = Math.max(...all.map((p) => p.v), 100);
  const pad = (hi - lo || 1) * 0.1;
  const X = (t: number) => x + 12 + ((t - t0) / (t1 - t0 || 1)) * (w - 24);
  const Y = (v: number) => y + h - 12 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (h - 24);
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(x, Y(100));
  ctx.lineTo(x + w, Y(100));
  ctx.stroke();
  ctx.setLineDash([]);
  const line = (pts: { t: number; v: number }[], color: string, dash: number[]) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash(dash);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line(bench, C.bench, [10, 6]);
  line(depot, C.depot, []);
}

function stat(ctx: Ctx, label: string, value: string, x: number, y: number, color = C.ink) {
  ctx.fillStyle = C.muted;
  ctx.font = `18px ${FONT}`;
  ctx.fillText(label, x, y);
  ctx.fillStyle = color;
  ctx.font = `bold 30px ${FONT}`;
  ctx.fillText(value, x, y + 36);
}

const tone = (x: number | null) => (x === null ? C.ink : x >= 0 ? C.up : C.down);

/** Draws the card. Pure drawing: the same run gives the same picture. */
export function drawRunCard(ctx: Ctx, run: RunSummary) {
  const day = run.resolution === "day";
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = C.muted;
  ctx.font = `20px ${FONT}`;
  ctx.fillText("DepoSim", 48, 56);
  ctx.fillStyle = C.ink;
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText(run.name.length > 34 ? `${run.name.slice(0, 33)}…` : run.name, 48, 106);
  ctx.fillStyle = C.muted;
  ctx.font = `20px ${FONT}`;
  const sub = [run.scenarioTitle, `Regeln: ${PRESET_LABEL[run.preset]}`, `${formatSimTime(run.startAt, day)} bis ${formatSimTime(run.simulationTime, day)}`].filter(Boolean).join(" · ");
  ctx.fillText(sub, 48, 140);

  const letter = run.grade.grade;
  ctx.fillStyle = letter ? GRADE_COLOR[letter] : C.muted;
  ctx.font = `bold 190px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText(letter ?? "–", 1060, 250);
  ctx.font = `20px ${FONT}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(letter ? `${run.grade.score?.toFixed(1).replace(".", ",")} Punkte` : "ohne Note", 1060, 290);
  if (run.scenario) {
    ctx.fillStyle = C.ink;
    ctx.font = `34px ${FONT}`;
    ctx.fillText(starText(run.scenario.stars), 1060, 340);
  }
  ctx.textAlign = "left";

  stat(ctx, "Rendite", run.totalReturn === null ? "—" : signedPercent(run.totalReturn), 48, 210, tone(run.totalReturn));
  stat(ctx, run.benchmarkSymbol ? `Maßstab ${run.benchmarkSymbol}` : "Maßstab", run.benchmarkReturn === null ? "—" : signedPercent(run.benchmarkReturn), 330, 210, tone(run.benchmarkReturn));
  stat(ctx, "Größter Rückgang", formatPercentPlain(run.maxDrawdown === null ? null : -run.maxDrawdown), 612, 210);
  stat(ctx, "Gebühren", formatPercentPlain(run.feeShare), 48, 290);
  stat(ctx, "Aufträge", String(run.trades), 330, 290);
  stat(ctx, "Endwert", formatEur(run.finalValue), 612, 290);

  drawCurve(ctx, run, 48, 360, 1104, 200);
  ctx.fillStyle = C.depot;
  ctx.font = `18px ${FONT}`;
  ctx.fillText("— Depot", 48, 592);
  if (run.curve.benchmark) {
    ctx.fillStyle = C.bench;
    ctx.fillText("- - Maßstab", 150, 592);
  }
  ctx.fillStyle = C.muted;
  ctx.textAlign = "right";
  ctx.fillText("Beide Linien auf 100 am Start", 1152, 592);
  ctx.textAlign = "left";
}

export function renderRunCard(run: RunSummary): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawRunCard(ctx, run);
  return canvas;
}

export const fileNameOf = (run: RunSummary) => `deposim-${run.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "runde"}.png`;
