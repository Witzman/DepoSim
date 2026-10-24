/** Milliseconds to wait before the next fetch is allowed: 0 when none was made yet or the pause is over. */
export function throttleDelay(lastAt: number | null, now: number, minGapMs: number): number {
  return lastAt === null ? 0 : Math.max(0, lastAt + minGapMs - now);
}
