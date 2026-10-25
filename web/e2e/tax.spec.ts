import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("the after-tax view is off at first, always carries its warning, and switches on with settings that stay", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Steuer");
  await page.getByTestId("by-day").check();
  await page.getByLabel("Datum").fill("2026-02-02");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("02.02.2026");
  await page.getByLabel("Menge").fill("20");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await page.getByRole("button", { name: "60 T/s" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("24.10.2026", { timeout: 20_000 });
  await page.getByRole("tab", { name: "Auswertung" }).click();

  const panel = page.getByTestId("tax");
  await expect(panel.getByTestId("tax-disclaimer")).toContainText("keine Steuerberatung");
  await expect(panel.getByTestId("tax-off")).toContainText("brutto");
  await expect(panel.getByTestId("tax-years")).toHaveCount(0);

  await panel.getByTestId("tax-switch").check();
  // a distribution was booked on the way, so the year shows, inside the allowance: no tax
  await expect(panel.getByTestId("tax-years")).toContainText("2026");
  await expect(panel.getByTestId("tax-total")).toContainText("0,00");
  await expect(panel.getByTestId("tax-chart")).toBeVisible();
  await expect(panel.getByTestId("tax-compare")).toContainText("Brutto (wie gebucht)");
  await expect(panel.getByTestId("tax-compare")).toContainText("Netto (Schätzung)");
  await expect(panel.getByTestId("tax-vorab")).toContainText("Vorabpauschale");
  await expect(panel.getByTestId("tax-rules")).toContainText(/26,3[78]/);
  await expect(panel.getByTestId("tax-disclaimer")).toBeVisible();

  await panel.getByTestId("tax-church").selectOption("0.09");
  await expect(panel.getByTestId("tax-rules")).toContainText(/(27,99|28,00)/);
  await panel.getByTestId("tax-allowance").fill("500");
  await panel.getByTestId("tax-allowance").blur();
  await expect(panel.getByTestId("tax-rules")).toContainText("eigener Wert");

  await page.reload();
  await page.getByRole("tab", { name: "Auswertung" }).click();
  await expect(page.getByTestId("tax").getByTestId("tax-switch")).toBeChecked();
  await expect(page.getByTestId("tax").getByTestId("tax-church")).toHaveValue("0.09");
});
