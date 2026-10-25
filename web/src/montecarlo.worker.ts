import { simulate, type McInput } from "./monteCarlo.js";

export interface McRequest { seq: number; input: McInput }

self.onmessage = (e: MessageEvent<McRequest>) => {
  const { seq, input } = e.data;
  self.postMessage({ seq, result: simulate(input) });
};
