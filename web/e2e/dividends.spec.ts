import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("a held title is credited on the ex-day and shows in the calendar and the income, with a withholding tax shown only as information", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Dividenden");
  await page.getByTestId("by-day").check();
  await page.getByLabel("Datum").fill("2026-09-01");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("01.09.2026");

  await page.getByLabel("Menge").fill("10");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await page.getByRole("button", { name: "60 T/s" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  // the made-up prices end on 23 October: the clock runs to there and stops by itself
  await expect(page.getByTestId("sim-time")).toHaveText("24.10.2026", { timeout: 20_000 });

  await page.getByRole("tab", { name: "Auswertung" }).click();
  const panel = page.getByTestId("dividends");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("income-total")).toContainText("€");
  await expect(page.getByTestId("income-total")).not.toContainText("0,00 €");
  const line = panel.getByTestId("div-SAP.DE");
  await expect(line).toContainText("Ex-Tag 17.09.2026");
  await expect(line).toContainText("gutgeschrieben");
  await expect(line).toContainText("Quelle Yahoo");
  await expect(line).toContainText("Dividendenrendite");
  await expect(panel.getByTestId("return-split")).toContainText("Rendite aus Ausschüttungen");

  const gross = await page.getByTestId("income-total").textContent();
  await page.getByTestId("withholding").selectOption("15");
  await expect(panel).toContainText("nach 15,00 % Quellensteuer");
  await expect(page.getByTestId("income-total")).not.toHaveText(gross!);
  await page.getByTestId("withholding").selectOption("0");
  await expect(page.getByTestId("income-total")).toHaveText(gross!);
});

test("a title without any distribution is said to have no data, not shown with zero", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Leer");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await page.getByRole("tab", { name: "Auswertung" }).click();
  await expect(page.getByTestId("income-empty")).toBeVisible();
  await expect(page.getByTestId("dividends")).toContainText("Das Depot hält keinen Titel");
});
