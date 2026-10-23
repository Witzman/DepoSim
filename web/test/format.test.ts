import { describe, expect, it } from "vitest";
import { formatEur, formatPrice, signedEur, signedPercent } from "../src/format.js";

const nb = " "; // Intl puts a no-break space before the currency sign

describe("formatEur", () => {
  it("formats cents in German style", () => {
    expect(formatEur(215043)).toBe(`2.150,43${nb}€`);
    expect(formatEur(0)).toBe(`0,00${nb}€`);
    expect(formatEur(-5)).toBe(`-0,05${nb}€`);
    expect(formatEur(1_000_000)).toBe(`10.000,00${nb}€`);
  });
});

describe("formatPrice", () => {
  it("shows the currency of the instrument", () => {
    expect(formatPrice(214.4, "EUR")).toBe(`214,40${nb}€`);
    expect(formatPrice(1234.5, "USD")).toBe(`1.234,50${nb}$`);
  });
});

describe("signedEur and signedPercent", () => {
  it("put a plus in front of a gain, so a gain and a loss differ by more than colour", () => {
    expect(signedEur(1234)).toBe(`+12,34${nb}€`);
    expect(signedEur(-5)).toBe(`-0,05${nb}€`);
    expect(signedEur(0)).toBe(`0,00${nb}€`);
    expect(signedPercent(0.0123)).toBe(`+1,23${nb}%`);
    expect(signedPercent(-0.5)).toBe(`-50,00${nb}%`);
  });
});
