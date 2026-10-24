import { useEffect, useRef, useState } from "react";
import { compute, type IndicatorConfig, type IndicatorResult } from "./indicators.js";
import type { WorkerRequest } from "./indicators.worker.js";

/**
 * Indicator values for the closes, computed off the main thread. Only the newest request
 * counts (latest wins by `seq`); without Worker support it computes inline.
 */
export function useIndicators(closes: number[], config: IndicatorConfig): { result: IndicatorResult; seq: number } {
  const [state, setState] = useState<{ result: IndicatorResult; seq: number }>({ result: {}, seq: 0 });
  const worker = useRef<Worker | null>(null);
  const sent = useRef(0);

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    try {
      const w = new Worker(new URL("./indicators.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<{ seq: number; result: IndicatorResult }>) => {
        if (e.data.seq !== sent.current) return; // stale
        setState({ result: e.data.result, seq: e.data.seq });
      };
      worker.current = w;
      return () => { w.terminate(); worker.current = null; };
    } catch {
      worker.current = null;
    }
  }, []);

  useEffect(() => {
    const seq = ++sent.current;
    if (Object.keys(config).length === 0) return setState({ result: {}, seq });
    if (worker.current) {
      const req: WorkerRequest = { seq, closes, config };
      worker.current.postMessage(req);
    } else {
      setState({ result: compute(closes, config), seq });
    }
  }, [closes, config]);

  return state;
}
