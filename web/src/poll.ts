/**
 * Calls `load` every `ms`, but not while the page is hidden and not while the last call has not answered yet. With eight panels
 * asking the server to recompute their figures, a slow answer used to bring a second, third request for the same thing.
 * Returns the function that stops it.
 */
export function poll(load: () => unknown, ms: number): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy || (typeof document !== "undefined" && document.hidden)) return;
    busy = true;
    void Promise.resolve(load()).catch(() => {}).finally(() => { busy = false; });
  }, ms);
  return () => clearInterval(timer);
}
