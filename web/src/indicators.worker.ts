import { compute, type IndicatorConfig, type Ohlcv } from "./indicators.js";

export interface WorkerRequest { seq: number; bars: Ohlcv[]; config: IndicatorConfig }

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { seq, bars, config } = e.data;
  self.postMessage({ seq, result: compute(bars.map((b) => b.c), config, bars) });
};
