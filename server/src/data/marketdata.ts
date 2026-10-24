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

/** One trading day. `day` is the UTC date of the bar, "YYYY-MM-DD". Prices are Yahoo's raw prices (split-adjusted, not dividend-adjusted). */
export interface DailyBarRow {
  day: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Yahoo gives the ex-date only. */
export interface DividendRow {
  exDay: string;
  amount: number;
}

export interface SplitRow {
  day: string;
  numerator: number;
  denominator: number;
}

export interface DailySeries {
  bars: DailyBarRow[];
  dividends: DividendRow[];
  splits: SplitRow[];
}

/** Daily bars with dividend and split events, for the long-term comparison. */
export interface DailyData {
  /** Days in [fromT, toT), UTC seconds. One call. */
  daily(symbol: string, fromT: number, toT: number): Promise<DailySeries>;
}
