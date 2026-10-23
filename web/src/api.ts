import type { Bar, ClientMessage, Instrument, ServerMessage, Simulation } from "./types.js";

/** An error with a message that can be shown to the person as it is. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError("Der Server ist nicht erreichbar.", 0);
  }
  if (!res.ok) {
    let message = `Fehler ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // not the usual JSON error: keep the status text
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const getWatchlist = () => request<Instrument[]>("/api/watchlist");
export const listSimulations = () => request<Simulation[]>("/api/simulations");
export const createSimulation = (body: { name: string; startAt: number; startCash?: number }) =>
  request<Simulation>("/api/simulations", json("POST", body));
export const deleteSimulation = (id: number) => request<void>(`/api/simulations/${id}`, { method: "DELETE" });
export const endSimulation = (id: number) => request<Simulation>(`/api/simulations/${id}/end`, json("POST", {}));

export async function getBars(id: number, symbol: string, limit: number): Promise<Bar[]> {
  const url = `/api/simulations/${id}/bars?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  return (await request<{ bars: Bar[] }>(url)).bars;
}

/** The socket follows the page: ws for http, wss for https, the same host. */
export function socketUrl(id: number, loc: { protocol: string; host: string }): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws/simulations/${id}`;
}

const KNOWN = new Set(["snapshot", "tick", "notice", "error"]);

/** A message from the server, or null for anything that is not one. */
export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw);
    return m && typeof m === "object" && KNOWN.has(m.type) ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}

export interface Socket {
  send(m: ClientMessage): void;
  close(): void;
}

export function openSocket(id: number, onMessage: (m: ServerMessage) => void, onClose: () => void): Socket {
  const ws = new WebSocket(socketUrl(id, location));
  ws.addEventListener("message", (e) => {
    const m = parseServerMessage(String(e.data));
    if (m) onMessage(m);
  });
  ws.addEventListener("close", onClose);
  const queue: string[] = [];
  ws.addEventListener("open", () => queue.splice(0).forEach((s) => ws.send(s)));
  return {
    send(m) {
      const s = JSON.stringify(m);
      if (ws.readyState === WebSocket.OPEN) ws.send(s);
      else queue.push(s);
    },
    close: () => ws.close(),
  };
}
