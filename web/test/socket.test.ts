import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSocket } from "../src/api.js";

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  sent: string[] = [];
  private on = new Map<string, ((e: any) => void)[]>();
  constructor(public url: string) { FakeSocket.all.push(this); }
  addEventListener(type: string, fn: (e: any) => void) { this.on.set(type, [...(this.on.get(type) ?? []), fn]); }
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; }
  emit(type: string, e: any = {}) { if (type === "open") this.readyState = 1; if (type === "close") this.readyState = 3; (this.on.get(type) ?? []).forEach((f) => f(e)); }
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "h" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("openSocket", () => {
  it("connects again with growing pauses after a drop, and tells the page at each step", () => {
    const events: string[] = [];
    openSocket(1, () => {}, () => events.push("close"), () => events.push("open"));
    FakeSocket.all[0].emit("open");
    FakeSocket.all[0].emit("close", { code: 1006 });
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].emit("close", { code: 1001 }); // dropped before it ever opened: the pause doubles
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2].emit("open");
    expect(events).toEqual(["open", "close", "close", "open"]);
  });

  it("does not connect again when the server closed for good, or when the page closed it", () => {
    const a = openSocket(1, () => {}, () => {});
    FakeSocket.all[0].emit("close", { code: 1008 });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    const b = openSocket(2, () => {}, () => {});
    b.close();
    FakeSocket.all[1].emit("close", { code: 1006 });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    void a;
  });

  it("sends what was asked before the first connection, and drops what was asked while none stood", () => {
    const s = openSocket(1, () => {}, () => {});
    s.send({ type: "run" });
    FakeSocket.all[0].emit("open");
    expect(FakeSocket.all[0].sent).toEqual(['{"type":"run"}']);
    FakeSocket.all[0].emit("close", { code: 1006 });
    s.send({ type: "run" }); // no connection: a late "run" would be a surprise
    vi.advanceTimersByTime(1000);
    FakeSocket.all[1].emit("open");
    expect(FakeSocket.all[1].sent).toEqual([]);
  });
});
