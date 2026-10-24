import { describe, expect, it } from "vitest";
import { addDrawing, hitTest, parse, removeDrawing, serialize, storageKey, type Drawing } from "../src/drawings.js";

const h: Drawing = { id: "a", kind: "hline", price: 100 };
const t: Drawing = { id: "b", kind: "trend", a: { t: 1000, price: 90 }, b: { t: 2000, price: 110 } };
const m: Drawing = { id: "c", kind: "marker", t: 1500, text: "Einstieg" };

describe("add and remove", () => {
  it("adds without touching the original list", () => {
    const list: Drawing[] = [h];
    const next = addDrawing(list, t);
    expect(next).toEqual([h, t]);
    expect(list).toEqual([h]);
  });
  it("removes by id and ignores unknown ids", () => {
    expect(removeDrawing([h, t, m], "b")).toEqual([h, m]);
    expect(removeDrawing([h], "zzz")).toEqual([h]);
  });
});

describe("serialize and parse", () => {
  it("round-trips", () => {
    expect(parse(serialize([h, t, m]))).toEqual([h, t, m]);
  });
  it("turns garbage into an empty list and never throws", () => {
    for (const raw of [null, "", "{", "null", "42", '"x"', '{"a":1}']) expect(parse(raw)).toEqual([]);
  });
  it("drops malformed entries and keeps the rest", () => {
    const raw = JSON.stringify([
      h,
      { id: "x", kind: "hline", price: "100" },
      { id: "y", kind: "hline", price: null },
      { id: "z", kind: "trend", a: { t: 1, price: 2 } },
      { id: "w", kind: "marker", t: 1, text: 5 },
      { id: "v", kind: "circle" },
      7, null,
      m,
    ]);
    expect(parse(raw)).toEqual([h, m]);
  });
  it("drops entries with non-finite numbers and duplicate ids", () => {
    const raw = '[{"id":"a","kind":"hline","price":1e999},{"id":"a","kind":"hline","price":5},{"id":"a","kind":"hline","price":6}]';
    expect(parse(raw)).toEqual([{ id: "a", kind: "hline", price: 5 }]);
  });
});

describe("storageKey", () => {
  it("is per simulation and symbol", () => {
    expect(storageKey(3, "SAP.DE")).not.toBe(storageKey(3, "SIE.DE"));
    expect(storageKey(3, "SAP.DE")).not.toBe(storageKey(4, "SAP.DE"));
    expect(storageKey(3, "SAP.DE")).toBe(storageKey(3, "SAP.DE"));
  });
});

describe("hitTest", () => {
  const project = { x: (time: number) => time / 10, y: (price: number) => 500 - price };
  it("finds a horizontal line near the click", () => {
    expect(hitTest([h], { x: 7, y: 403 }, project, 8)).toBe("a");
    expect(hitTest([h], { x: 7, y: 450 }, project, 8)).toBeNull();
  });
  it("finds a trend line by its distance to the segment, not the extended line", () => {
    // from (100, 410) to (200, 390)
    expect(hitTest([t], { x: 150, y: 400 }, project, 8)).toBe("b");
    expect(hitTest([t], { x: 300, y: 370 }, project, 8)).toBeNull();
  });
  it("finds a marker by its x position", () => {
    expect(hitTest([m], { x: 152, y: 10 }, project, 8)).toBe("c");
    expect(hitTest([m], { x: 200, y: 10 }, project, 8)).toBeNull();
  });
  it("picks the nearest of several", () => {
    const near: Drawing = { id: "n", kind: "hline", price: 98 };
    expect(hitTest([h, near], { x: 0, y: 402 }, project, 8)).toBe("n");
  });
  it("ignores drawings that cannot be projected", () => {
    expect(hitTest([h], { x: 0, y: 400 }, { x: () => null, y: () => null }, 8)).toBeNull();
  });
});
