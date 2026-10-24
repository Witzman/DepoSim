/** A value curve as percent change against its first point. A first value of zero has no percent, so no curve. */
export function normalize(points: { t: number; value: number }[]): { t: number; pct: number }[] {
  if (points.length === 0 || points[0].value === 0) return [];
  const base = points[0].value;
  return points.map((p) => ({ t: p.t, pct: ((p.value - base) / base) * 100 }));
}

/** The chosen depot, or the first one when the choice is gone or was never made. */
export function pickDepot<T extends { id: number }>(depots: T[], chosen: number | null): T | undefined {
  return depots.find((d) => d.id === chosen) ?? depots[0];
}
