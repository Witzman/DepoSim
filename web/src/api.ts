import type {
  AllocationLine, ArchiveInfo, AutoPause, FlagReport, BackfillJob, BackupStatus, Coverage, DataStatus, GapReport, HintsResult, JobsOverview, SourceSummary, Bar, ClientMessage, CompareResult, CostPreview, Curves, Depot, DividendCalendar, Evaluation, Instrument, Journal, JournalNoteResult, MarketEvent, TaxReport, TaxSettings,
  Longterm, LongtermJob, MissingList, OrderInput, Orderbook, RollingResult, RunSummary, Scenario, ScenarioResult, SearchHit, ServerMessage, Simulation, Rules, VenueInfo,
} from "./types.js";

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
export const searchInstruments = (q: string) =>
  request<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`);
export const addInstrument = (symbol: string) => request<Instrument>("/api/watchlist", json("POST", { symbol }));
export const removeInstrument = (symbol: string) =>
  request<void>(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: "DELETE" });
export const listSimulations = () => request<Simulation[]>("/api/simulations");
export const createSimulation = (body: {
  name: string; startAt?: number; live?: boolean; startCash?: number;
  resolution?: "minute" | "day"; preset?: "relaxed" | "realistic" | "hardcore"; rules?: Partial<Omit<Rules, "preset">>;
  scenarioId?: string;
}) =>
  request<Simulation>("/api/simulations", json("POST", body));
export const getScenarios = () => request<Scenario[]>("/api/scenarios");
export const getMarketEvents = (id: number, symbols: string[]) =>
  request<MarketEvent[]>(`/api/simulations/${id}/events?symbols=${encodeURIComponent(symbols.join(","))}`);
export const getTax = (id: number, depotId: number) => request<TaxReport>(`/api/simulations/${id}/tax?depotId=${depotId}`);
export const putTax = (id: number, patch: Partial<TaxSettings>) => request<TaxSettings>(`/api/simulations/${id}/tax`, json("PUT", patch));
export const getRolling = (id: number, depotId: number) =>
  request<RollingResult>(`/api/simulations/${id}/rolling?depotId=${depotId}`);
export const getDividends = (id: number, depotId: number) =>
  request<DividendCalendar>(`/api/simulations/${id}/dividends?depotId=${depotId}`);
export const getRuns = () => request<RunSummary[]>("/api/runs");
export const getRun = (id: number) => request<RunSummary>(`/api/simulations/${id}/run`);
export const getResult = (id: number) => request<ScenarioResult>(`/api/simulations/${id}/result`);
export const setAutoPause = (id: number, autoPause: Partial<AutoPause>) =>
  request<Simulation>(`/api/simulations/${id}`, json("PATCH", { autoPause }));
export const deleteSimulation = (id: number) => request<void>(`/api/simulations/${id}`, { method: "DELETE" });
export const endSimulation = (id: number) => request<Simulation>(`/api/simulations/${id}/end`, json("POST", {}));

/** `skipped` is only given for a daily simulation: trading days without a price in the range. */
export async function getBars(id: number, symbol: string, limit: number): Promise<{ bars: Bar[]; skipped: number }> {
  const url = `/api/simulations/${id}/bars?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  const r = await request<{ bars: Bar[]; skipped?: number }>(url);
  return { bars: r.bars, skipped: r.skipped ?? 0 };
}

export const previewOrder = (id: number, o: OrderInput) =>
  request<{ cost: CostPreview; problem?: string; notes?: string[] }>(`/api/simulations/${id}/orders/preview`, json("POST", o));
export const placeOrder = async (id: number, o: OrderInput) =>
  (await request<{ orderId: number }>(`/api/simulations/${id}/orders`, json("POST", o))).orderId;
export const cancelOrder = (id: number, orderId: number) =>
  request<void>(`/api/simulations/${id}/orders/${orderId}`, { method: "DELETE" });

export const getCurves = (id: number) => request<Curves>(`/api/simulations/${id}/curves`);
export const getEvaluation = (id: number) => request<Evaluation>(`/api/simulations/${id}/evaluation`);
export const setBenchmark = (id: number, symbol: string | null) =>
  request<Simulation>(`/api/simulations/${id}`, json("PATCH", { benchmark: symbol }));
export const addDepot = (id: number, name?: string) =>
  request<Depot>(`/api/simulations/${id}/depots`, json("POST", name === undefined ? {} : { name }));
export const renameDepot = (id: number, depotId: number, name: string) =>
  request<Depot>(`/api/simulations/${id}/depots/${depotId}`, json("PATCH", { name }));
export const removeDepot = (id: number, depotId: number) =>
  request<void>(`/api/simulations/${id}/depots/${depotId}`, { method: "DELETE" });
export const addGhost = (id: number, depotId: number) =>
  request<Depot>(`/api/simulations/${id}/depots/${depotId}/ghost`, json("POST", {}));

export const getBackupStatus = () => request<BackupStatus>("/api/backup/status");
/** The file goes up as it is; the server checks it and answers with what it saved before replacing. */
export const restoreBackup = (file: Blob) =>
  request<{ simulations: number; savedBefore: string }>("/api/backup/restore?confirm=ja", {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: file,
  });
export async function importSimulation(file: File): Promise<Simulation> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new ApiError("Die Datei ist kein JSON.", 0);
  }
  return request<Simulation>("/api/simulations/import", json("POST", parsed));
}

export const getVenues = () => request<VenueInfo[]>("/api/venues");
export const getMissing = () => request<MissingList>("/api/archive/missing");
export const startBackfill = () => request<BackfillJob>("/api/archive/backfill", json("POST", {}));
export const getBackfill = () => request<BackfillJob>("/api/archive/backfill");

export const getHints = (id: number, depotId: number) => request<HintsResult>(`/api/simulations/${id}/hints?depotId=${depotId}`);
export const setHintPref = (id: number, rule: string, patch: { enabled?: boolean; hidden?: boolean; levels?: number[] }) =>
  request<void>(`/api/simulations/${id}/hints/${rule}`, json("PUT", patch));
export const getJournal = (id: number, depotId: number) => request<Journal>(`/api/simulations/${id}/journal?depotId=${depotId}`);
export const saveJournalNote = (id: number, tradeKey: string, text: string) =>
  request<JournalNoteResult>(`/api/simulations/${id}/journal/${encodeURIComponent(tradeKey)}`, json("PUT", { text }));
export const compareSimulations = (ids: number[]) => request<CompareResult>(`/api/simulations/compare?ids=${ids.join(",")}`);
export const getOrderbook = (id: number, symbol: string) =>
  request<Orderbook>(`/api/simulations/${id}/orderbook?symbol=${encodeURIComponent(symbol)}`);

export async function allocate(
  id: number, depotId: number, weights: { symbol: string; percent: number }[], dryRun: boolean,
): Promise<AllocationLine[]> {
  const body = await request<{ lines: AllocationLine[] }>(
    `/api/simulations/${id}/depots/${depotId}/allocate`, json("POST", { weights, dryRun }),
  );
  return body.lines;
}

/** The socket follows the page: ws for http, wss for https, the same host. */
export function socketUrl(id: number, loc: { protocol: string; host: string }): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws/simulations/${id}`;
}

const KNOWN = new Set(["snapshot", "tick", "notice", "paused", "error"]);

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

/** Closed by the server for good (an unknown or removed simulation): connecting again would only ask the same. */
const FINAL_CLOSE = new Set([1000, 1008]);
const RECONNECT_FIRST_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/**
 * The socket of one simulation. When the connection drops (a deploy, a restart, a restore, a lost network) it connects again
 * with growing pauses; the server answers every new connection with a snapshot. `onClose` is called at each drop and
 * `onOpen` at each connection, so the page can say that it is waiting. What was sent while no connection stood is dropped:
 * a "run" that arrives minutes late is not what the person meant.
 */
export function openSocket(id: number, onMessage: (m: ServerMessage) => void, onClose: () => void, onOpen: () => void = () => {}): Socket {
  let ws: WebSocket;
  let stopped = false;
  let everOpen = false;
  let delay = RECONNECT_FIRST_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: string[] = [];

  const connect = () => {
    const socket = new WebSocket(socketUrl(id, location));
    ws = socket;
    socket.addEventListener("message", (e) => {
      const m = parseServerMessage(String(e.data));
      if (m) onMessage(m);
    });
    socket.addEventListener("open", () => {
      everOpen = true;
      delay = RECONNECT_FIRST_MS;
      queue.splice(0).forEach((s) => socket.send(s));
      onOpen();
    });
    socket.addEventListener("close", (e) => {
      if (stopped || ws !== socket) return;
      queue = [];
      onClose();
      if (FINAL_CLOSE.has(e.code)) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    });
  };
  connect();

  return {
    send(m) {
      const s = JSON.stringify(m);
      if (ws.readyState === WebSocket.OPEN) ws.send(s);
      else if (ws.readyState === WebSocket.CONNECTING && !everOpen) queue.push(s); // before the first connection: wait for it
      // else: no connection now, and a late command would be a surprise
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws.close();
    },
  };
}

export const getLongterm = () => request<Longterm>("/api/longterm");
export const startLongtermRefresh = () => request<LongtermJob>("/api/longterm/refresh", json("POST", {}));
export const getLongtermRefresh = () => request<LongtermJob>("/api/longterm/refresh");

export const getDataStatus = () => request<DataStatus>("/api/data/status");
export const getCoverage = (days = 30) => request<Coverage>(`/api/data/coverage?days=${days}`);
export const getGaps = (symbol: string, day: string) =>
  request<GapReport>(`/api/data/gaps?symbol=${encodeURIComponent(symbol)}&day=${day}`);
export const getSources = async () => (await request<{ sources: SourceSummary[] }>("/api/data/source")).sources;
export const getFlags = (symbol?: string) => request<FlagReport>(`/api/data/flags${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`);
export const getArchiveInfo = () => request<ArchiveInfo>("/api/data/archive");
export const getJobs = () => request<JobsOverview>("/api/jobs");
export const runJob = (name: string) => request<unknown>(`/api/jobs/${encodeURIComponent(name)}/run`, json("POST", {}));
