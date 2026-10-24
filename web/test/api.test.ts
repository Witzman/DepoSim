import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError, addInstrument, cancelOrder, createSimulation, deleteSimulation, getBars, listSimulations, parseServerMessage,
  placeOrder, previewOrder, removeInstrument, searchInstruments, socketUrl,
} from "../src/api.js";

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("createSimulation", () => {
  it("posts the body as JSON and returns the simulation", async () => {
    const fn = stubFetch(201, { id: 4, name: "T" });
    const sim = await createSimulation({ name: "T", startAt: 1000 });
    expect(sim).toMatchObject({ id: 4 });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/simulations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "T", startAt: 1000 });
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("raises the server's own message as readable text when the source fails", async () => {
    stubFetch(502, { error: "Die Kursquelle drosselt die Abrufe." });
    const err = await createSimulation({ name: "T", startAt: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Die Kursquelle drosselt die Abrufe.");
    expect(err.status).toBe(502);
  });

  it("falls back to the status when the answer is not the usual JSON error", async () => {
    stubFetch(500, "<html>boom</html>");
    const err = await createSimulation({ name: "T", startAt: 1 }).catch((e) => e);
    expect(err.message).toBe("Fehler 500");
  });

  it("says the server cannot be reached when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await listSimulations().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/nicht erreichbar/);
  });
});

describe("getBars", () => {
  it("passes the symbol, escaped, and the limit", async () => {
    const fn = stubFetch(200, { symbol: "EURUSD=X", bars: [] });
    await getBars(3, "EURUSD=X", 200);
    expect(fn.mock.calls[0][0]).toBe("/api/simulations/3/bars?symbol=EURUSD%3DX&limit=200");
  });

  it("returns the bars", async () => {
    stubFetch(200, { symbol: "SAP.DE", bars: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }] });
    expect(await getBars(1, "SAP.DE", 5)).toHaveLength(1);
  });
});

describe("deleteSimulation", () => {
  it("resolves on 204 and raises the message on 404", async () => {
    stubFetch(204, undefined);
    await expect(deleteSimulation(1)).resolves.toBeUndefined();
    stubFetch(404, { error: "Unbekannte Simulation." });
    await expect(deleteSimulation(1)).rejects.toThrow("Unbekannte Simulation.");
  });
});

describe("socketUrl", () => {
  it("follows the page: ws for http, wss for https, same host", () => {
    expect(socketUrl(3, { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/ws/simulations/3");
    expect(socketUrl(3, { protocol: "https:", host: "depo.witzman.de" })).toBe("wss://depo.witzman.de/ws/simulations/3");
  });
});

describe("parseServerMessage", () => {
  it("reads the four message types", () => {
    expect(parseServerMessage('{"type":"notice","text":"x"}')).toEqual({ type: "notice", text: "x" });
    expect(parseServerMessage('{"type":"tick","simulationTime":5,"newBars":{}}')?.type).toBe("tick");
    expect(parseServerMessage('{"type":"snapshot"}')?.type).toBe("snapshot");
    expect(parseServerMessage('{"type":"error","text":"x"}')?.type).toBe("error");
  });

  it("answers null for what it does not know, instead of throwing", () => {
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage('{"type":"surprise"}')).toBeNull();
    expect(parseServerMessage("42")).toBeNull();
    expect(parseServerMessage("null")).toBeNull();
  });
});

describe("orders", () => {
  const order = { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 } as const;

  it("previewOrder posts the order and returns the cost and the problem", async () => {
    const fn = stubFetch(200, { cost: { total: 11395 }, problem: "Das Guthaben reicht nicht." });
    const r = await previewOrder(3, order);
    expect(r).toEqual({ cost: { total: 11395 }, problem: "Das Guthaben reicht nicht." });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/simulations/3/orders/preview");
    expect(JSON.parse(String(init.body))).toEqual(order);
  });

  it("previewOrder raises the server's reason, for example when there is no price yet", async () => {
    stubFetch(400, { error: "Für AAPL gibt es noch keinen Kurs." });
    await expect(previewOrder(3, { ...order, symbol: "AAPL" })).rejects.toThrow("Für AAPL gibt es noch keinen Kurs.");
  });

  it("placeOrder returns the order id and raises the rejection", async () => {
    stubFetch(201, { orderId: 12 });
    await expect(placeOrder(3, order)).resolves.toBe(12);
    stubFetch(400, { error: "Die Menge muss eine positive ganze Zahl sein." });
    await expect(placeOrder(3, { ...order, qty: 0 })).rejects.toThrow(/Menge/);
  });

  it("cancelOrder deletes the order", async () => {
    const fn = stubFetch(204, undefined);
    await expect(cancelOrder(3, 12)).resolves.toBeUndefined();
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/simulations/3/orders/12");
    expect(init.method).toBe("DELETE");
  });
});

describe("createSimulation, live", () => {
  it("sends the live flag and no start when the simulation starts from now", async () => {
    const fn = stubFetch(201, { id: 5, live: true });
    await createSimulation({ name: "Live", live: true });
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: "Live", live: true });
  });
});

describe("instrument search and watchlist", () => {
  it("encodes the query of a search and returns the hits", async () => {
    const fn = stubFetch(200, [{ symbol: "X", known: false }]);
    expect(await searchInstruments("a b&c")).toEqual([{ symbol: "X", known: false }]);
    expect(fn.mock.calls[0][0]).toBe("/api/search?q=a%20b%26c");
  });

  it("posts the symbol as JSON to add an instrument", async () => {
    const fn = stubFetch(201, { symbol: "BMW.DE" });
    expect(await addInstrument("BMW.DE")).toMatchObject({ symbol: "BMW.DE" });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/watchlist");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ symbol: "BMW.DE" });
  });

  it("deletes the encoded symbol and raises the server's text on a 409", async () => {
    const fn = stubFetch(204, undefined);
    await removeInstrument("A^B");
    expect(fn.mock.calls[0][0]).toBe("/api/watchlist/A%5EB");
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe("DELETE");

    stubFetch(409, { error: "Das Wertpapier wird gehalten oder hat offene Orders." });
    const err = await removeInstrument("AAPL").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/gehalten/);
  });
});
