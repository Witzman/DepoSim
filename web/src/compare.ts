export const MAX_COMPARE = 4;

/** Adds or removes an id from the chosen simulations; a fifth is not taken. */
export function toggleChoice(chosen: number[], id: number): number[] {
  if (chosen.includes(id)) return chosen.filter((x) => x !== id);
  return chosen.length >= MAX_COMPARE ? chosen : [...chosen, id];
}

/**
 * A curve on its own time axis: seconds since its first point. Points that do not move on in
 * time are dropped, the chart wants strictly rising times.
 */
export function elapsedSeries(points: { t: number; pct: number }[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (const p of points) {
    const time = p.t - points[0].t;
    if (out.length === 0 || time > out[out.length - 1].time) out.push({ time, value: p.pct });
  }
  return out;
}
