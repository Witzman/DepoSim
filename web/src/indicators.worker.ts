import { compute, type IndicatorConfig } from "./indicators.js";

export interface WorkerRequest { seq: number; closes: number[]; config: IndicatorConfig }

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { seq, closes, config } = e.data;
  self.postMessage({ seq, result: compute(closes, config) });
};
