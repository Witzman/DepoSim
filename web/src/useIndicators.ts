import { useEffect, useRef, useState } from "react";
import { compute, type IndicatorConfig, type IndicatorResult, type Ohlcv } from "./indicators.js";
import type { WorkerRequest } from "./indicators.worker.js";

/** A cheap identity of a bar list: two titles with as many bars still differ in prices. */
export const barsKey = (bars: Ohlcv[]): string =>
  bars.length === 0 ? "0" : `${bars.length}|${bars[0].t}|${bars[0].o}|${bars[bars.length - 1].t}|${bars[bars.length - 1].c}`;

/**
 * Indicator values for the bars, computed off the main thread. Only the newest request
 * counts (latest wins by `seq`); without Worker support it computes inline.
 */
export function useIndicators(bars: Ohlcv[], config: IndicatorConfig): { result: IndicatorResult; seq: number; key: string } {
  const [state, setState] = useState<{ result: IndicatorResult; seq: number; key: string }>({ result: {}, seq: 0, key: "0" });
  const keys = useRef(new Map<number, string>());
  const worker = useRef<Worker | null>(null);
  const sent = useRef(0);

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    try {
      const w = new Worker(new URL("./indicators.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<{ seq: number; result: IndicatorResult }>) => {
        if (e.data.seq !== sent.current) return; // stale
        setState({ result: e.data.result, seq: e.data.seq, key: keys.current.get(e.data.seq) ?? "" });
        keys.current.clear();
      };
      worker.current = w;
      return () => { w.terminate(); worker.current = null; };
    } catch {
      worker.current = null;
    }
  }, []);

  useEffect(() => {
    const seq = ++sent.current;
    const key = barsKey(bars);
    keys.current.set(seq, key);
    if (Object.keys(config).length === 0) return setState({ result: {}, seq, key });
    if (worker.current) {
      const req: WorkerRequest = { seq, bars, config };
      worker.current.postMessage(req);
    } else {
      setState({ result: compute(bars.map((b) => b.c), config, bars), seq, key });
    }
  }, [bars, config]);

  return state;
}
