import type { Cent } from "./money.js";
import { type FeeConfig } from "./fees.js";

export type RulePreset = "relaxed" | "realistic" | "hardcore" | "custom";

/** The rules of one simulation. Chosen when it is made, never changed afterwards. */
export interface Rules {
  /** What the rules were started from; `custom` when a switch differs from every preset. */
  preset: RulePreset;
  /** Times the spread of the fee model. */
  spreadFactor: number;
  /** Times commission (percent, minimum, maximum), the foreign flat fee and the currency markup. */
  feeFactor: number;
  pauseAllowed: boolean;
  /** The tempo stays what it was when the simulation was made. */
  tempoLocked: boolean;
  /** Reserved: branching a simulation is not built yet (#27 names it, a later issue builds it). */
  allowFork: boolean;
  /** The most different positions a depot may hold; null: no limit. */
  maxPositions: number | null;
}

export type Switches = Omit<Rules, "preset">;

export const PRESETS: Record<Exclude<RulePreset, "custom">, Switches> = {
  relaxed: { spreadFactor: 1, feeFactor: 1, pauseAllowed: true, tempoLocked: false, allowFork: true, maxPositions: null },
  realistic: { spreadFactor: 1, feeFactor: 1, pauseAllowed: true, tempoLocked: false, allowFork: true, maxPositions: null },
  hardcore: { spreadFactor: 2, feeFactor: 2, pauseAllowed: false, tempoLocked: true, allowFork: false, maxPositions: null },
};

export const PRESET_NAMES: Record<RulePreset, string> = {
  relaxed: "Entspannt", realistic: "Realistisch", hardcore: "Hardcore", custom: "Eigene Regeln",
};

export const RELAXED: Rules = { preset: "relaxed", ...PRESETS.relaxed };

const same = (a: Switches, b: Switches) => (Object.keys(a) as (keyof Switches)[]).every((k) => a[k] === b[k]);

/** A preset with single switches changed. A result that equals the preset keeps its name; anything else is `custom`. */
export function resolveRules(preset: Exclude<RulePreset, "custom"> = "relaxed", overrides: Partial<Switches> = {}): Rules {
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) as Partial<Switches>;
  const switches: Switches = { ...PRESETS[preset], ...clean };
  if (same(switches, PRESETS[preset])) return { preset, ...switches };
  return { preset: "custom", ...switches };
}

const scaleCent = (c: Cent, f: number): Cent => Math.round(c * f);

/** The fee model with the factors folded in, so the preview and the execution use the same numbers. */
export function applyRules(fees: FeeConfig, rules: Rules): FeeConfig {
  const f = rules.feeFactor;
  return {
    commissionPct: fees.commissionPct * f,
    commissionMin: scaleCent(fees.commissionMin, f),
    commissionMax: scaleCent(fees.commissionMax, f),
    foreignFlat: scaleCent(fees.foreignFlat, f),
    fxMarkupPct: fees.fxMarkupPct * f,
    spreadPct: fees.spreadPct * rules.spreadFactor,
  };
}

export const PAUSE_REFUSED = "In dieser Simulation gibt es keine Pause: Die Uhr läuft weiter.";
export const TEMPO_REFUSED = "In dieser Simulation ist das Tempo festgelegt.";
export const CLOCK_STOPPED_REFUSED = "In dieser Simulation handelst du nur bei laufender Uhr.";
export const JUMP_REFUSED = "In dieser Simulation gibt es keine Sprünge und keine Auto-Pause: Die Uhr hält nie an.";
