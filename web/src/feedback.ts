import { throttleDelay } from "./throttle.js";

/** What happened that deserves a small signal. */
export type FeedbackKind = "buy" | "sell" | "partial" | "rejected" | "limit" | "event" | "roundEnd";

export interface FeedbackPrefs {
  /** Off by default: nothing is heard until the person turns it on. */
  sound: boolean;
  haptics: boolean;
  /** Reduces motion on top of the system setting. */
  reducedMotion: boolean;
}

export const FEEDBACK_KEY = "deposim-feedback";
export const defaultFeedbackPrefs = (): FeedbackPrefs => ({ sound: false, haptics: true, reducedMotion: false });

/** Never throws; anything unusable falls back to the defaults. */
export function parseFeedbackPrefs(raw: string | null): FeedbackPrefs {
  const out = defaultFeedbackPrefs();
  if (!raw) return out;
  try {
    const o = JSON.parse(raw);
    for (const k of ["sound", "haptics", "reducedMotion"] as const) if (typeof o?.[k] === "boolean") out[k] = o[k];
  } catch { /* the defaults stay */ }
  return out;
}

export function loadFeedbackPrefs(): FeedbackPrefs {
  try {
    return parseFeedbackPrefs(localStorage.getItem(FEEDBACK_KEY));
  } catch {
    return defaultFeedbackPrefs();
  }
}

export function saveFeedbackPrefs(p: FeedbackPrefs): void {
  try {
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(p));
  } catch { /* the choice then lasts only until the page is closed */ }
}

interface Tone { hz: number; ms: number; at?: number }

/** Short, soft, synthetic. Buying sounds higher than selling; there is no melody for winning or losing. */
export const TONES: Record<FeedbackKind, Tone[]> = {
  buy: [{ hz: 660, ms: 60 }],
  sell: [{ hz: 520, ms: 60 }],
  partial: [{ hz: 590, ms: 40 }],
  rejected: [{ hz: 180, ms: 140 }],
  limit: [{ hz: 880, ms: 50 }, { hz: 880, ms: 50, at: 90 }],
  event: [{ hz: 740, ms: 90 }],
  roundEnd: [{ hz: 440, ms: 90 }, { hz: 660, ms: 140, at: 110 }],
};

const VIBRATION: Partial<Record<FeedbackKind, number | number[]>> = {
  buy: 15, sell: 15, partial: 10, limit: 15, rejected: [30, 40, 30],
};

/** Quiet: never louder than this, so it does not shout over the rest. */
const VOLUME = 0.04;
/** The shortest time between two signals of one kind. At high tempo many orders fill; this keeps it to a tick. */
export const MIN_GAP_MS = 150;

export interface AudioLike {
  currentTime: number;
  destination: unknown;
  createOscillator(): { type: string; frequency: { value: number }; connect(n: unknown): void; start(t?: number): void; stop(t?: number): void };
  createGain(): { gain: { setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void }; connect(n: unknown): void };
  resume?(): Promise<void>;
}

export interface FeedbackEnv {
  prefs: () => FeedbackPrefs;
  /** A new audio context, or null where there is none. Called at the earliest after the first interaction. */
  audio: () => AudioLike | null;
  vibrate: ((pattern: number | number[]) => boolean) | null;
  now: () => number;
  /** True once the person has clicked or pressed a key: browsers refuse sound before. */
  interacted: () => boolean;
}

/** The one function the rest of the app calls. It does nothing that is switched off, and never throws. */
export function createFeedback(env: FeedbackEnv): (kind: FeedbackKind) => void {
  let ctx: AudioLike | null | undefined;
  const last = new Map<FeedbackKind, number>();
  return (kind) => {
    try {
      const at = env.now();
      if (throttleDelay(last.get(kind) ?? null, at, MIN_GAP_MS) > 0) return;
      last.set(kind, at);
      const prefs = env.prefs();
      if (prefs.haptics && env.vibrate && VIBRATION[kind] !== undefined) env.vibrate(VIBRATION[kind]!);
      if (!prefs.sound || !env.interacted()) return;
      if (ctx === undefined) ctx = env.audio();
      if (!ctx) return;
      void ctx.resume?.();
      for (const tone of TONES[kind]) {
        const start = ctx.currentTime + (tone.at ?? 0) / 1000;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = tone.hz;
        gain.gain.setValueAtTime(VOLUME, start);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.ms / 1000);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + tone.ms / 1000 + 0.02);
      }
    } catch { /* feedback is a nicety: a failure is never shown */ }
  };
}

let touched = false;
if (typeof document !== "undefined") {
  const mark = () => { touched = true; };
  document.addEventListener("pointerdown", mark, { once: true, capture: true });
  document.addEventListener("keydown", mark, { once: true, capture: true });
}

let current: FeedbackPrefs | null = null;
export const feedbackPrefs = (): FeedbackPrefs => (current ??= loadFeedbackPrefs());
export function setFeedbackPrefs(p: FeedbackPrefs): void {
  current = p;
  saveFeedbackPrefs(p);
  applyMotion(p);
}

/** Sets `data-motion="reduced"` on the page when the person or the system wants less movement. */
export function applyMotion(p: FeedbackPrefs): void {
  if (typeof document === "undefined") return;
  const system = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.dataset.motion = p.reducedMotion || system ? "reduced" : "full";
}

export const feedback = createFeedback({
  prefs: feedbackPrefs,
  audio: () => {
    const Ctor = (globalThis as { AudioContext?: new () => AudioLike }).AudioContext
      ?? (globalThis as { webkitAudioContext?: new () => AudioLike }).webkitAudioContext;
    return Ctor ? new Ctor() : null;
  },
  vibrate: typeof navigator !== "undefined" && typeof navigator.vibrate === "function" ? (p) => navigator.vibrate(p) : null,
  now: () => performance.now(),
  interacted: () => touched,
});
