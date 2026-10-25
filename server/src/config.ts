export const PORT = Number(process.env.PORT ?? 3000);
export const DB_PATH = process.env.DB_PATH ?? "./data/deposim.sqlite";

/** A positive number from the environment, or the default: a typo must not stop the clock. */
function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Where the daily backup goes: an own folder, set by the environment so that the server's backup can reach it. */
export const BACKUP_DIR = process.env.BACKUP_DIR;
/** How many daily backups are kept. */
export const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) > 0 ? Math.floor(Number(process.env.BACKUP_KEEP)) : 7;

export interface Settings {
  /** How far behind the present the price source is, in seconds. Not measured yet. */
  liveDelayS: number;
  /** The tempo a live simulation catches up at. */
  catchUpTempo: number;
  /** The shortest time between two refreshes of today's prices, in seconds. */
  liveRefreshS: number;
}

export function readSettings(env: Record<string, string | undefined>): Settings {
  return {
    liveDelayS: positive(env.LIVE_DELAY_S, 900),
    catchUpTempo: positive(env.CATCH_UP_TEMPO, 300),
    liveRefreshS: positive(env.LIVE_REFRESH_S, 60),
  };
}

export const SETTINGS = readSettings(process.env);

export interface JobSettings {
  /** False (`JOBS=off`): the scheduler runs nothing by itself; a job can still be started by hand. */
  enabled: boolean;
  /** Per job, from `JOB_<NAME>`: "off" or a local "HH:MM". Anything else is ignored. */
  overrides: Record<string, "off" | string>;
}

/** The job names are those of `jobs.ts`; `sammlung-xetra` reads `JOB_SAMMLUNG_XETRA`. */
export const JOB_NAMES = ["sammlung-xetra", "sammlung-us", "luecken", "tageskurse", "pruefung", "wechselkurse", "sicherung", "pflege"];

export function readJobSettings(env: Record<string, string | undefined>, names: string[] = JOB_NAMES): JobSettings {
  const overrides: JobSettings["overrides"] = {};
  for (const name of names) {
    const v = env[`JOB_${name.toUpperCase().replace(/-/g, "_")}`]?.trim().toLowerCase();
    if (v === "off" || (v !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(v))) overrides[name] = v;
  }
  return { enabled: env.JOBS?.trim().toLowerCase() !== "off", overrides };
}

/** The markets an instrument can be traded on, which means the markets with a price source. */
export type Venue = "XETRA" | "US";

/** Every market the app knows, including those it has no prices for. */
export type VenueId = Venue | "FRANKFURT" | "TRADEGATE" | "GETTEX";

export interface VenueInfo {
  id: VenueId;
  name: string;
  /** IANA zone the hours are given in. */
  timeZone: string;
  /** Local "HH:MM"; trading runs from `opens` up to, not including, `closes`, Monday to Friday. */
  opens: string;
  closes: string;
  /** False: there is no usable price source, so the market is shown but nothing can be added or traded on it. */
  hasSource: boolean;
  /** Which trading calendar (holidays, short days) applies. Absent: none is known, every weekday counts as a trading day. */
  calendar?: "XETRA" | "NYSE";
  note: string;
}

export const VENUES: VenueInfo[] = [
  { id: "XETRA", name: "Xetra", timeZone: "Europe/Berlin", opens: "09:00", closes: "17:30", hasSource: true, calendar: "XETRA",
    note: "Minutenbalken von Yahoo (gemessen)." },
  { id: "US", name: "US-Börsen", timeZone: "America/New_York", opens: "09:30", closes: "16:00", hasSource: true, calendar: "NYSE",
    note: "Minutenbalken von Yahoo (gemessen)." },
  { id: "FRANKFURT", name: "Frankfurt", timeZone: "Europe/Berlin", opens: "08:00", closes: "22:00", hasSource: false,
    note: "Yahoo liefert für .F nur lückenhafte Minutenbalken (gemessen 2026-10-24: 16 bis 124 am Tag, Lücken bis zu drei Stunden, ETFs gar keine). Damit ließe sich nicht ehrlich handeln." },
  { id: "TRADEGATE", name: "Tradegate", timeZone: "Europe/Berlin", opens: "08:00", closes: "22:00", hasSource: false,
    note: "Bei Yahoo nicht auffindbar (gemessen 2026-10-24). Zeiten nach Angabe des Betreibers, nicht gemessen." },
  { id: "GETTEX", name: "gettex", timeZone: "Europe/Berlin", opens: "08:00", closes: "22:00", hasSource: false,
    note: "Bei Yahoo nicht auffindbar (gemessen 2026-10-24). Zeiten nach Angabe des Betreibers, nicht gemessen." },
];

/** Yahoo suffixes of markets without a source; a symbol with one of them is turned away when added. */
export const SOURCELESS_SUFFIXES: Record<string, VenueId> = { ".F": "FRANKFURT", ".TG": "TRADEGATE", ".GETTEX": "GETTEX" };

export interface Instrument {
  symbol: string;
  name: string;
  currency: "EUR" | "USD";
  venue: Venue;
  /** Equity or fund; only a fund is told apart, an equity without a sector is "unbekannt". */
  kind?: "EQUITY" | "ETF";
  /** The sector the source names for an equity. Funds have none. */
  sector?: string;
}

/** How many instruments the person may add to the starting list. Each one is a request per refresh. */
export const MAX_ADDED = 12;

/** The most depots one simulation may hold. */
export const MAX_DEPOTS = 8;

/** The exchange rate is a price series like the others, not a tradable instrument. */
export const FX_SYMBOL = "EURUSD=X";

const us = (symbol: string, name: string, sector?: string): Instrument => ({
  symbol, name, currency: "USD", venue: "US", kind: sector ? "EQUITY" : "ETF", ...(sector ? { sector } : {}),
});
const xetra = (symbol: string, name: string, sector?: string): Instrument => ({
  symbol, name, currency: "EUR", venue: "XETRA", kind: sector ? "EQUITY" : "ETF", ...(sector ? { sector } : {}),
});

export const WATCHLIST: Instrument[] = [
  us("AAPL", "Apple", "Technology"),
  us("MSFT", "Microsoft", "Technology"),
  us("NVDA", "NVIDIA", "Technology"),
  us("TSLA", "Tesla", "Consumer Cyclical"),
  xetra("SAP.DE", "SAP", "Technology"),
  xetra("SIE.DE", "Siemens", "Industrials"),
  xetra("ALV.DE", "Allianz", "Financial Services"),
  xetra("EUNL.DE", "iShares Core MSCI World (Acc)"),
  xetra("VWCE.DE", "Vanguard FTSE All-World (Acc)"),
  xetra("SXR8.DE", "iShares Core S&P 500 (Acc)"),
  xetra("SXRV.DE", "iShares Nasdaq 100 (Acc)"),
  xetra("EXS1.DE", "iShares Core DAX"),
  xetra("EXSA.DE", "iShares STOXX Europe 600"),
  xetra("IS3N.DE", "iShares Core MSCI EM IMI (Acc)"),
  xetra("4GLD.DE", "Xetra-Gold"),
  us("SPY", "SPDR S&P 500"),
  us("QQQ", "Invesco QQQ (Nasdaq 100)"),
  us("VTI", "Vanguard Total Stock Market"),
];

export const JOB_SETTINGS = readJobSettings(process.env);
