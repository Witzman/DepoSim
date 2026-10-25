import { useEffect, useRef, useState } from "react";
import { simulate, type McInput, type McRefused, type McResult } from "./monteCarlo.js";
import type { McRequest } from "./montecarlo.worker.js";

type Out = McResult | McRefused;

/**
 * The simulated paths for the input, computed off the main thread. Only the newest request counts
 * (latest wins by `seq`); without Worker support it computes inline. `null` while one is under way.
 */
export function useMonteCarlo(input: McInput | null): { result: Out | null; busy: boolean } {
  const [state, setState] = useState<{ result: Out | null; busy: boolean }>({ result: null, busy: false });
  const worker = useRef<Worker | null>(null);
  const sent = useRef(0);

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    try {
      const w = new Worker(new URL("./montecarlo.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<{ seq: number; result: Out }>) => {
        if (e.data.seq !== sent.current) return; // stale
        setState({ result: e.data.result, busy: false });
      };
      worker.current = w;
      return () => { w.terminate(); worker.current = null; };
    } catch {
      worker.current = null;
    }
  }, []);

  useEffect(() => {
    const seq = ++sent.current;
    if (!input) return setState({ result: null, busy: false });
    if (worker.current) {
      setState((s) => ({ ...s, busy: true }));
      const req: McRequest = { seq, input };
      worker.current.postMessage(req);
    } else {
      setState({ result: simulate(input), busy: false });
    }
  }, [input]);

  return state;
}
