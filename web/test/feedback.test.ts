import { describe, expect, it, vi } from "vitest";
import { type AudioLike, type FeedbackPrefs, MIN_GAP_MS, TONES, createFeedback, defaultFeedbackPrefs, parseFeedbackPrefs } from "../src/feedback.js";

function setup(prefs: Partial<FeedbackPrefs> = {}, opts: { interacted?: boolean; audio?: boolean } = {}) {
  const oscillators: { hz: number }[] = [];
  const ctx: AudioLike = {
    currentTime: 0, destination: {},
    createOscillator: () => {
      const o = { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
      oscillators.push({ get hz() { return o.frequency.value; } });
      return o;
    },
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
  };
  const state = { now: 1000, prefs: { ...defaultFeedbackPrefs(), ...prefs }, interacted: opts.interacted ?? true };
  const created = vi.fn(() => (opts.audio === false ? null : ctx));
  const vibrate = vi.fn(() => true);
  const f = createFeedback({ prefs: () => state.prefs, audio: created, vibrate, now: () => state.now, interacted: () => state.interacted });
  return { f, oscillators, created, vibrate, state };
}

describe("defaults and storage", () => {
  it("is silent until turned on", () => {
    expect(defaultFeedbackPrefs()).toEqual({ sound: false, haptics: true, reducedMotion: false });
  });

  it("falls back to the defaults on anything unusable and keeps valid fields", () => {
    expect(parseFeedbackPrefs(null)).toEqual(defaultFeedbackPrefs());
    expect(parseFeedbackPrefs("{not json")).toEqual(defaultFeedbackPrefs());
    expect(parseFeedbackPrefs(JSON.stringify({ sound: "yes", haptics: false }))).toEqual({ sound: false, haptics: false, reducedMotion: false });
    expect(parseFeedbackPrefs(JSON.stringify({ sound: true, reducedMotion: true }))).toEqual({ sound: true, haptics: true, reducedMotion: true });
  });
});

describe("feedback", () => {
  it("plays nothing while sound is off, and does not even open an audio context", () => {
    const t = setup();
    t.f("buy");
    expect(t.oscillators).toHaveLength(0);
    expect(t.created).not.toHaveBeenCalled();
  });

  it("plays one tone per event kind once sound is on", () => {
    const t = setup({ sound: true });
    let n = 0;
    for (const kind of Object.keys(TONES) as (keyof typeof TONES)[]) {
      t.state.now += MIN_GAP_MS + 1;
      t.f(kind);
      n += TONES[kind].length;
      expect(t.oscillators).toHaveLength(n);
    }
  });

  it("buys higher than it sells, and has no tune for winning or losing", () => {
    expect(TONES.buy[0].hz).toBeGreaterThan(TONES.sell[0].hz);
    expect(TONES.rejected[0].hz).toBeLessThan(TONES.sell[0].hz);
    expect(Object.keys(TONES).sort()).toEqual(["buy", "event", "limit", "partial", "rejected", "roundEnd", "sell"]);
  });

  it("makes no sound before the person has touched the page", () => {
    const t = setup({ sound: true }, { interacted: false });
    t.f("buy");
    expect(t.oscillators).toHaveLength(0);
    expect(t.created).not.toHaveBeenCalled();
    t.state.interacted = true;
    t.state.now += MIN_GAP_MS + 1;
    t.f("buy");
    expect(t.oscillators).toHaveLength(1);
  });

  it("does not fail where there is no audio", () => {
    const t = setup({ sound: true }, { audio: false });
    expect(() => t.f("buy")).not.toThrow();
  });

  it("keeps a burst of one kind down to one signal per gap", () => {
    const t = setup({ sound: true });
    t.f("buy"); t.f("buy"); t.f("buy");
    expect(t.oscillators).toHaveLength(1);
    t.state.now += MIN_GAP_MS;
    t.f("buy");
    expect(t.oscillators).toHaveLength(2);
  });

  it("vibrates only for fills and rejections, and only when haptics are on", () => {
    const t = setup();
    t.f("buy");
    expect(t.vibrate).toHaveBeenCalledWith(15);
    t.state.now += MIN_GAP_MS + 1;
    t.f("rejected");
    expect(t.vibrate).toHaveBeenLastCalledWith([30, 40, 30]);
    t.state.now += MIN_GAP_MS + 1;
    t.f("event");
    expect(t.vibrate).toHaveBeenCalledTimes(2);
    const off = setup({ haptics: false });
    off.f("buy");
    expect(off.vibrate).not.toHaveBeenCalled();
  });

  it("swallows an error from the audio API", () => {
    const f = createFeedback({
      prefs: () => ({ ...defaultFeedbackPrefs(), sound: true }), audio: () => { throw new Error("blocked"); }, vibrate: null, now: () => 1, interacted: () => true,
    });
    expect(() => f("buy")).not.toThrow();
  });
});
