/** Euro cents, always a whole number. Prices are plain numbers, amounts never are. */
export type Cent = number;

/** Half away from zero, symmetric around 0. The `+ 0` turns -0 into 0. */
export function roundCent(x: number): Cent {
  return (x < 0 ? -Math.round(-x) : Math.round(x)) + 0;
}
