import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poll } from "../src/poll.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("poll", () => {
  it("does not ask again while the last question has no answer", async () => {
    let calls = 0;
    let answer: () => void = () => {};
    const stop = poll(() => { calls++; return new Promise<void>((r) => { answer = r; }); }, 1000);
    vi.advanceTimersByTime(3500);
    expect(calls).toBe(1);
    answer();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
  });

  it("stays quiet while the page is hidden, and survives a failing call", async () => {
    const doc = { hidden: true };
    vi.stubGlobal("document", doc);
    let calls = 0;
    poll(() => { calls++; return Promise.reject(new Error("x")); }, 1000);
    vi.advanceTimersByTime(3000);
    expect(calls).toBe(0);
    doc.hidden = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
  });
});
