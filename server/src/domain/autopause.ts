/** Rules that stop the clock by themselves. Every switch is off until the person turns it on. */
export interface AutoPause {
  /** An order was executed. */
  onFill: boolean;
  /** The price came within `nearLimitPct` of the limit of an open limit order. */
  nearLimit: boolean;
  nearLimitPct: number;
  /** A held title (or one with an open order) moved by `jumpPct` within `jumpMinutes`. */
  jump: boolean;
  jumpPct: number;
  jumpMinutes: number;
  /** A market opened. */
  onOpen: boolean;
  /** A dividend or a split was booked. */
  onEvent: boolean;
}

export type AutoPauseRule = "fill" | "event" | "open" | "near" | "jump";

export const DEFAULT_AUTOPAUSE: AutoPause = {
  onFill: false, nearLimit: false, nearLimitPct: 0.005, jump: false, jumpPct: 0.03, jumpMinutes: 10, onOpen: false, onEvent: false,
};

const BOOLS = ["onFill", "nearLimit", "jump", "onOpen", "onEvent"] as const;
const clampNum = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Whatever was stored: unusable parts fall back to the defaults, numbers are kept inside sensible bounds. */
export function parseAutoPause(raw: unknown): AutoPause {
  const o = (typeof raw === "string" ? safeJson(raw) : raw) as Record<string, unknown> | null;
  const out = { ...DEFAULT_AUTOPAUSE };
  if (!o || typeof o !== "object") return out;
  for (const k of BOOLS) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  out.nearLimitPct = clampNum(o.nearLimitPct, 0.0005, 0.1, DEFAULT_AUTOPAUSE.nearLimitPct);
  out.jumpPct = clampNum(o.jumpPct, 0.005, 0.5, DEFAULT_AUTOPAUSE.jumpPct);
  out.jumpMinutes = Math.round(clampNum(o.jumpMinutes, 1, 240, DEFAULT_AUTOPAUSE.jumpMinutes));
  return out;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** The distance of a price from a limit as a share of the limit, or null when the limit is not positive. */
export function distanceToLimit(price: number, limit: number): number | null {
  return limit > 0 ? Math.abs(price - limit) / limit : null;
}

/** The change from `then` to `now` as a ratio when its size reaches `pct`, otherwise null. */
export function jumpOf(now: number, then: number, pct: number): number | null {
  if (!(then > 0)) return null;
  const change = now / then - 1;
  return Math.abs(change) >= pct ? change : null;
}

/** What happened since the last look, each as a line of words. */
export interface Signals {
  fills: string[];
  bookings: string[];
  opened: string[];
  near: string[];
  jumps: string[];
}

export const noSignals = (): Signals => ({ fills: [], bookings: [], opened: [], near: [], jumps: [] });

/**
 * The reason to stop the clock, or null. Only the rules that are on count; if several apply the first in this order
 * names the reason (an execution before a jump) and the rest are added as "und n weitere".
 */
export function pauseReason(prefs: AutoPause, s: Signals): { rule: AutoPauseRule; reason: string } | null {
  const hits: { rule: AutoPauseRule; lines: string[] }[] = [];
  if (prefs.onFill && s.fills.length) hits.push({ rule: "fill", lines: s.fills });
  if (prefs.onEvent && s.bookings.length) hits.push({ rule: "event", lines: s.bookings });
  if (prefs.onOpen && s.opened.length) hits.push({ rule: "open", lines: s.opened });
  if (prefs.nearLimit && s.near.length) hits.push({ rule: "near", lines: s.near });
  if (prefs.jump && s.jumps.length) hits.push({ rule: "jump", lines: s.jumps });
  if (hits.length === 0) return null;
  const all = hits.flatMap((h) => h.lines);
  const rest = all.length - 1;
  return { rule: hits[0].rule, reason: `Automatisch angehalten: ${all[0]}${rest > 0 ? ` (und ${rest} weitere${rest === 1 ? "s" : ""})` : ""}` };
}
