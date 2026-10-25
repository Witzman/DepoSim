/** The guided first steps (#37): steps as data, each with a test over what the app already knows. */

export interface GuideStep {
  id: string;
  title: string;
  /** One or two short sentences. */
  text: string;
}

export const STEPS: GuideStep[] = [
  { id: "start", title: "Simulation anlegen und starten", text: "Lege mit „Neue Simulation“ einen Handelstag an und drücke Start. Die Uhr läuft dann durch den echten Kursverlauf dieses Tages." },
  { id: "timeframe", title: "Zeitrahmen wechseln", text: "Über dem Chart wählst du, wie lang eine Kerze ist. Eine Kerze zeigt Eröffnung, Hoch, Tief und Schluss eines Zeitraums." },
  { id: "buy", title: "Etwas kaufen", text: "Wähle Menge 1 und drücke „Kaufen“. Eine Market-Order wird sofort zum aktuellen Kurs ausgeführt, mit kleinem Aufschlag (Spread)." },
  { id: "limit", title: "Eine Limit-Order setzen", text: "Stelle „Art“ auf Limit und nenne einen Preis. Die Order wartet, bis der Kurs diesen Preis erreicht." },
  { id: "indicator", title: "Einen Indikator einblenden", text: "Unter „Indikatoren“ legst du eine Linie über den Chart, zum Beispiel einen Durchschnitt (SMA). Er fasst den bisherigen Kursverlauf zusammen." },
  { id: "drawing", title: "Etwas einzeichnen", text: "Wähle ein Zeichenwerkzeug und klicke in den Chart, zum Beispiel eine waagerechte Linie für einen Preis, den du beobachten willst." },
  { id: "sell", title: "Verkaufen", text: "Stelle die Seite auf Verkauf und verkaufe, was du hältst. Danach steht der Trade im Journal; dort kannst du eine Notiz dazu schreiben." },
  { id: "evaluation", title: "Auswertung und Maßstab ansehen", text: "Öffne „Auswertung“ und wähle einen Maßstab, zum Beispiel einen Index-ETF. So siehst du, ob du besser warst als der Markt." },
];

export interface GuideFacts {
  /** A simulation exists and its clock has moved. */
  started: boolean;
  orders: { side: "buy" | "sell"; kind: "market" | "limit"; status: string }[];
  /** Things only the interface knows: "timeframe", "indicator", "drawing", "evaluation", "benchmark". */
  seen: ReadonlySet<string>;
}

export const DONE: Record<string, (f: GuideFacts) => boolean> = {
  start: (f) => f.started,
  timeframe: (f) => f.seen.has("timeframe"),
  buy: (f) => f.orders.some((o) => o.side === "buy" && o.kind === "market" && o.status === "filled"),
  limit: (f) => f.orders.some((o) => o.kind === "limit" && o.status !== "rejected"),
  indicator: (f) => f.seen.has("indicator"),
  drawing: (f) => f.seen.has("drawing"),
  sell: (f) => f.orders.some((o) => o.side === "sell" && o.status === "filled"),
  evaluation: (f) => f.seen.has("evaluation") && f.seen.has("benchmark"),
};

/** Steps that are done now or were before (a step stays done when the simulation is deleted). */
export function doneSteps(facts: GuideFacts, latched: readonly string[]): string[] {
  return STEPS.filter((s) => latched.includes(s.id) || DONE[s.id](facts)).map((s) => s.id);
}

/** The data-guide target to highlight for the first step that is not done. */
export function targetOf(stepId: string, facts: GuideFacts, simulations: number): string {
  switch (stepId) {
    case "start": return simulations === 0 ? "new-sim" : "start";
    case "timeframe": return "timeframe";
    case "buy": return "ticket-submit";
    case "limit": return "ticket-kind";
    case "indicator": return "indicators";
    case "drawing": return "draw";
    case "sell": return "ticket-sell";
    default: return facts.seen.has("evaluation") ? "benchmark" : "tab-evaluation";
  }
}

export interface GuideStored {
  /** The person closed the panel, or an existing user never got it. */
  dismissed: boolean;
  seen: string[];
  done: string[];
}

export const GUIDE_KEY = "deposim-guide";

/** Never throws; null when nothing usable is stored. */
export function parseGuide(raw: string | null): GuideStored | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    if (typeof o?.dismissed !== "boolean") return null;
    return { dismissed: o.dismissed, seen: strings(o.seen), done: strings(o.done) };
  } catch {
    return null;
  }
}

/** Whether the guide shows itself the first time: only for someone who has no simulation yet. */
export const showsFirstTime = (simulationCount: number) => simulationCount === 0;

type Listener = () => void;
let state: GuideStored | null | undefined;
const listeners = new Set<Listener>();

function read(): GuideStored | null {
  if (state === undefined) {
    try {
      state = parseGuide(localStorage.getItem(GUIDE_KEY));
    } catch {
      state = null;
    }
  }
  return state;
}

function write(next: GuideStored): void {
  state = next;
  try {
    localStorage.setItem(GUIDE_KEY, JSON.stringify(next));
  } catch { /* the progress then lasts only until the page is closed */ }
  listeners.forEach((l) => l());
}

export const guideSnapshot = (): GuideStored | null => read();
export function subscribeGuide(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** First look at the list of simulations: decides once, and keeps the answer. */
export function initGuide(simulationCount: number): void {
  if (read() !== null) return;
  write({ dismissed: !showsFirstTime(simulationCount), seen: [], done: [] });
}

export function markSeen(flag: string): void {
  const cur = read();
  if (!cur || cur.seen.includes(flag)) return;
  write({ ...cur, seen: [...cur.seen, flag] });
}

export function latchDone(ids: string[]): void {
  const cur = read();
  if (!cur || ids.every((i) => cur.done.includes(i))) return;
  write({ ...cur, done: [...new Set([...cur.done, ...ids])] });
}

export const dismissGuide = (): void => { const cur = read(); if (cur) write({ ...cur, dismissed: true }); };
/** Starts again from the first step. */
export const restartGuide = (): void => write({ dismissed: false, seen: [], done: [] });
