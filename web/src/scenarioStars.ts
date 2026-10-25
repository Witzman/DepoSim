const KEY = "deposim.scenarioStars";

function read(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The most stars reached in a scenario on this device; 0 when it was not finished yet. */
export function bestStars(scenarioId: string): number {
  const n = read()[scenarioId];
  return typeof n === "number" && n >= 0 && n <= 3 ? n : 0;
}

/** Remembers `stars` if they beat the best so far. Storage may be blocked; then nothing is kept. */
export function rememberStars(scenarioId: string, stars: number): void {
  if (stars <= bestStars(scenarioId)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), [scenarioId]: stars }));
  } catch {
    /* private window or full storage: the stars are shown in the result anyway */
  }
}

export const starText = (n: number) => "★".repeat(n) + "☆".repeat(Math.max(0, 3 - n));
