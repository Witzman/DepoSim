import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("a bought and sold position in a daily simulation shows up in the review, the behaviour card and the tax view", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Runde");
  await page.getByTestId("by-day").check();
  await page.getByLabel("Datum").fill("2026-03-02");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("02.03.2026");

  await page.getByLabel("Menge").fill("20");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await page.getByTestId("day-step").click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  for (let i = 0; i < 6; i++) await page.getByTestId("day-step").click();

  await page.getByRole("button", { name: "Verkauf", exact: true }).click();
  await page.getByLabel("Menge").fill("20");
  await page.getByRole("button", { name: "Verkaufen" }).click();
  await page.getByTestId("day-step").click();
  await expect(page.getByTestId("position-SAP.DE")).toHaveCount(0);

  await page.getByRole("tab", { name: "Auswertung" }).click();
  const journal = page.getByTestId("journal");
  await expect(journal.getByTestId("hit-rate")).toContainText("n = 1");

  // the review reads the daily candles of the holding
  await expect(journal.getByTestId("review-summary")).toContainText("MAE, Median");
  await journal.getByRole("button", { name: "Nachbetrachtung" }).first().click();
  const detail = journal.locator("[data-testid^='review-'][data-testid*=':']:not([data-testid^='review-toggle'])").first();
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("review-efficiency")).toBeVisible();
  await expect(detail).toContainText("Kerzen der Haltezeit");

  // under ten trades the behaviour card says it is too early
  await expect(journal.getByTestId("behavior-early")).toContainText("Zu früh");
  await expect(journal.getByTestId("behavior-hours-reason")).toContainText("Tageskurs");

  // the sale is a result of a share: it lands in the share pot of its year
  const tax = page.getByTestId("tax");
  await tax.getByTestId("tax-switch").check();
  const years = tax.getByTestId("tax-years");
  await expect(years).toContainText("2026");
  const row = years.getByRole("row").filter({ hasText: "2026" });
  await expect(row.locator("td").first()).not.toHaveText(/^\s*0,00/); // the pot of shares holds the result of the round trip
});
