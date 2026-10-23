/** How far a simulation is behind the present: "unter 1 Min.", "45 Min.", "2 Std.", "3 Std. 20 Min.". */
export function formatLag(seconds: number): string {
  const minutes = Math.floor(Math.max(seconds, 0) / 60);
  if (minutes < 1) return "unter 1 Min.";
  if (minutes < 60) return `${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} Std.` : `${hours} Std. ${rest} Min.`;
}
