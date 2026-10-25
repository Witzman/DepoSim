import { describe, expect, it } from "vitest";
import { basisLabel, formatEur, formatPercentPlain, formatPrice, formatRatio, signedEur, signedPercent } from "../src/format.js";

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

describe("formatRatio and formatPercentPlain", () => {
  it("writes a ratio with a German decimal comma, and a dash for nothing", () => {
    expect(formatRatio(1.2345)).toBe("1,23");
    expect(formatRatio(-0.5)).toBe("-0,50");
    expect(formatRatio(null)).toBe("—");
    expect(formatPercentPlain(0.1234)).toBe(`12,34${nb}%`);
    expect(formatPercentPlain(null)).toBe("—");
    expect(formatPercentPlain(-0.25)).toBe(`-25,00${nb}%`);
  });

  it("never shows a negative zero", () => {
    expect(formatRatio(-0.0001)).toBe("0,00");
    expect(formatPercentPlain(-0.00001)).toBe(`0,00${nb}%`);
  });
});

describe("basisLabel", () => {
  it("names the step the figures are computed from", () => {
    expect(basisLabel("day")).toBe("Tageswerte");
    expect(basisLabel("hour")).toBe("Stundenwerte");
    expect(basisLabel("5min")).toBe("5-Minuten-Werte");
    expect(basisLabel(null)).toBe("—");
  });
});

describe("parseEuro", () => {
  it("reads German and plain notation, and never mistakes a decimal point for a thousands separator", async () => {
    const { parseEuro } = await import("../src/format.js");
    expect(parseEuro("1.500,50")).toBe(1500.5);
    expect(parseEuro("1500.5")).toBe(1500.5);
    expect(parseEuro("801.5")).toBe(801.5);
    expect(parseEuro("  ")).toBeNull();
    expect(parseEuro("abc")).toBeNull();
    expect(parseEuro("-3")).toBeNull();
  });
});
