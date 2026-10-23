/** One minute of trading. `t` is the UTC second the minute begins. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type MarketDataErrorKind = "rate_limited" | "no_data" | "bad_shape" | "network";

export class MarketDataError extends Error {
  readonly kind: MarketDataErrorKind;

  constructor(kind: MarketDataErrorKind, message: string) {
    super(message);
    this.name = "MarketDataError";
    this.kind = kind;
  }
}

export interface MarketData {
  /** Minute bars in [fromT, toT), UTC seconds. */
  bars(symbol: string, fromT: number, toT: number): Promise<Bar[]>;
}
