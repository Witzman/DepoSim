/** A value curve as percent change against its first point. A first value of zero has no percent, so no curve. */
export function normalize(points: { t: number; value: number }[]): { t: number; pct: number }[] {
  if (points.length === 0 || points[0].value === 0) return [];
  const base = points[0].value;
  return points.map((p) => ({ t: p.t, pct: ((p.value - base) / base) * 100 }));
}

/**
 * The chosen depot; when the choice is gone or was never made, the first normal depot
 * (a ghost is never the default), and only if there is none the first one.
 */
export function pickDepot<T extends { id: number; kind?: "normal" | "ghost" }>(depots: T[], chosen: number | null): T | undefined {
  return depots.find((d) => d.id === chosen) ?? depots.find((d) => d.kind !== "ghost") ?? depots[0];
}

/** Whether a ghost can be made of this depot, and if not, why. */
export function canGhost(depot: { kind: "normal" | "ghost"; positions: unknown[] }): { ok: true } | { ok: false; reason: string } {
  if (depot.kind === "ghost") return { ok: false, reason: "Von einem Geisterdepot gibt es keinen Geist." };
  if (depot.positions.length === 0) return { ok: false, reason: "Ein Geisterdepot braucht mindestens eine Position." };
  return { ok: true };
}
