/** Which simulation to open on load: the one used last if it still exists, else the newest. */
export function pickInitial(simulations: { id: number }[], storedId: number | null): number | null {
  if (simulations.length === 0) return null;
  if (storedId !== null && simulations.some((s) => s.id === storedId)) return storedId;
  return simulations[simulations.length - 1].id;
}
