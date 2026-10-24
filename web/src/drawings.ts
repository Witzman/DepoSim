// Chart drawings: pure helpers. They live in localStorage per simulation and symbol.
export type Drawing =
  | { id: string; kind: "hline"; price: number }
  | { id: string; kind: "trend"; a: { t: number; price: number }; b: { t: number; price: number } }
  | { id: string; kind: "marker"; t: number; text: string };

export const MAX_TEXT = 40;

export const addDrawing = (list: Drawing[], d: Drawing): Drawing[] => [...list, d];
export const removeDrawing = (list: Drawing[], id: string): Drawing[] => list.filter((d) => d.id !== id);
export const serialize = (list: Drawing[]): string => JSON.stringify(list);
export const storageKey = (simulationId: number, symbol: string) => `deposim-drawings:${simulationId}:${symbol}`;

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const point = (v: unknown): v is { t: number; price: number } =>
  typeof v === "object" && v !== null && fin((v as { t?: unknown }).t) && fin((v as { price?: unknown }).price);

function valid(d: unknown): d is Drawing {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "") return false;
  if (o.kind === "hline") return fin(o.price);
  if (o.kind === "trend") return point(o.a) && point(o.b);
  if (o.kind === "marker") return fin(o.t) && typeof o.text === "string";
  return false;
}

/** Drops malformed and duplicate entries; never throws. */
export function parse(raw: string | null): Drawing[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: Drawing[] = [];
  for (const d of data) {
    if (!valid(d) || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d.kind === "hline" ? { id: d.id, kind: "hline", price: d.price }
      : d.kind === "trend" ? { id: d.id, kind: "trend", a: { t: d.a.t, price: d.a.price }, b: { t: d.b.t, price: d.b.price } }
      : { id: d.id, kind: "marker", t: d.t, text: d.text.slice(0, MAX_TEXT) });
  }
  return out;
}

export interface Projection {
  x: (t: number) => number | null;
  y: (price: number) => number | null;
}

function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

/** The id of the drawing nearest to a click (in pixels) within `tolerance`, else null. */
export function hitTest(list: Drawing[], click: { x: number; y: number }, proj: Projection, tolerance: number): string | null {
  let best: string | null = null;
  let bestDistance = tolerance;
  for (const d of list) {
    let dist: number | null = null;
    if (d.kind === "hline") {
      const y = proj.y(d.price);
      if (y !== null) dist = Math.abs(click.y - y);
    } else if (d.kind === "trend") {
      const ax = proj.x(d.a.t), ay = proj.y(d.a.price), bx = proj.x(d.b.t), by = proj.y(d.b.price);
      if (ax !== null && ay !== null && bx !== null && by !== null) {
        dist = segmentDistance(click, { x: ax, y: ay }, { x: bx, y: by });
      }
    } else {
      const x = proj.x(d.t);
      if (x !== null) dist = Math.abs(click.x - x);
    }
    if (dist !== null && dist <= bestDistance) {
      best = d.id;
      bestDistance = dist;
    }
  }
  return best;
}
