/**
 * The German rules for the "after tax" view, in one place. A simplification for learning, no tax advice.
 * Every figure here names where it comes from; change the file, not the code, when the law changes.
 */
export const TAX_RULES = {
  /** The day these rules were last looked at. */
  asOf: "2026-10-25",
  /** Abgeltungsteuer on capital income. § 32d Abs. 1 EStG. */
  abgeltung: 0.25,
  /** Solidaritätszuschlag, a share of the tax. § 4 SolzG. */
  soli: 0.055,
  /** Kirchensteuer rates on offer (8 % Bayern and Baden-Württemberg, 9 % elsewhere), a share of the tax. § 51a EStG. */
  church: [0, 0.08, 0.09] as const,
  /** Teilfreistellung: the share of fund income that is free of tax. § 20 InvStG. */
  partialExemption: { equityFund: 0.3, mixedFund: 0.15, other: 0 },
  /**
   * Sparerpauschbetrag per person and calendar year in euro. § 20 Abs. 9 EStG: raised from 801 to 1.000 for 2023 on by the
   * Jahressteuergesetz 2022 (Bundesrat 16.12.2022); checked 2026-10-25 against advice sites (vlh.de, lohnsteuer-kompakt.de),
   * not against the statute text.
   */
  allowance: { from: 2023, now: 1000, before: 801 },
  /**
   * Basiszins for the Vorabpauschale (BMF), as far as confirmed by secondary sources on 2026-10-25. The advance lump sum is
   * not worked out (see `notes/reference/tax.md`), the table is kept for the day it is.
   */
  baseRate: { 2024: 0.0229, 2025: 0.0253, 2026: 0.032 } as Record<number, number>,
  sources: [
    "§ 20 EStG (Einkünfte aus Kapitalvermögen; Abs. 6 Satz 4 Aktienverluste nur mit Aktiengewinnen, besteht weiter; Abs. 9 Sparerpauschbetrag, 801 € bis 2022, 1.000 € ab 2023)",
    "§ 32d EStG (Abgeltungsteuer), § 43a EStG (Steuerabzug), § 4 SolzG, § 51a EStG",
    "InvStG § 18 (Vorabpauschale), § 20 (Teilfreistellung)",
    "BMF-Schreiben vom 13.01.2026 (Basiszins 2026: 3,20 %)",
  ],
} as const;

export type FundType = "equityFund" | "mixedFund" | "other";

export const FUND_TYPES: FundType[] = ["equityFund", "mixedFund", "other"];

export const allowanceFor = (year: number): number => (year >= TAX_RULES.allowance.from ? TAX_RULES.allowance.now : TAX_RULES.allowance.before);

/** The tax rate on one euro of income: 25 % plus Soli and Kirchensteuer, both a share of the 25 %-tax that is reduced for the church tax. */
export function effectiveRate(church: number): number {
  const base = TAX_RULES.abgeltung / (1 + TAX_RULES.abgeltung * church); // § 32d Abs. 1 S. 3 EStG
  return base * (1 + TAX_RULES.soli + church);
}
