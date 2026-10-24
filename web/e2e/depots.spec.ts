import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Depots");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByLabel("Menge")).toBeEnabled();
}

test("a second depot trades on its own and the tabs switch between them", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("button", { name: "+ Depot" }).click();
  await expect(page.getByRole("tab", { name: "Depot 2" })).toHaveAttribute("aria-selected", "true");

  await page.getByLabel("Menge").fill("1");
  await expect(page.getByTestId("cost-total")).toBeVisible();
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  const cash2 = await page.getByTestId("cash").textContent();

  await page.getByRole("tab", { name: "Depot 1" }).click();
  await expect(page.getByText("Noch keine Positionen.")).toBeVisible();
  await expect(page.getByTestId("cash")).toHaveText("10.000,00 €");
  expect(cash2).not.toBe("10.000,00 €");
});

test("an allocation in percent is planned first and then placed", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("button", { name: "Aufbau nach Prozent" }).click();
  const dialog = page.getByRole("dialog", { name: "Aufbau nach Prozent" });
  await dialog.getByLabel("Wertpapier 1").selectOption("SAP.DE");
  await dialog.getByLabel("Anteil 1 in Prozent").fill("50");
  await dialog.getByRole("button", { name: "Zeile hinzufügen" }).click();
  await dialog.getByLabel("Wertpapier 2").selectOption("SIE.DE");
  await dialog.getByLabel("Anteil 2 in Prozent").fill("60");
  await expect(dialog.getByTestId("alloc-sum")).toContainText("110");
  await expect(dialog.getByRole("button", { name: "Vorschau" })).toBeDisabled();

  await dialog.getByLabel("Anteil 2 in Prozent").fill("50");
  await dialog.getByRole("button", { name: "Vorschau" }).click();
  await expect(dialog.getByTestId("alloc-result").getByRole("row")).toHaveCount(3);
  await expect(page.getByTestId("position-SAP.DE")).toHaveCount(0); // a plan places nothing

  await dialog.getByRole("button", { name: "Orders erzeugen" }).click();
  await expect(dialog.getByRole("status")).toContainText("Kauforders sind gelegt");
  await dialog.getByRole("button", { name: "Schließen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  await expect(page.getByTestId("position-SIE.DE")).toBeVisible();
});

test("the evaluation tab compares the curves of both depots", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("button", { name: "+ Depot" }).click();
  await page.getByRole("tab", { name: "Auswertung" }).click();
  await expect(page.getByTestId("curves")).toHaveAttribute("data-series", "2");
  await expect(page.getByTestId("legend-1")).toContainText("Depot 1");
  await expect(page.getByLabel("Legende")).toContainText("Depot 2");
});

test("the last depot cannot be deleted, another one can", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("button", { name: "Depot verwalten" }).click();
  const dialog = page.getByRole("dialog", { name: "Depot verwalten" });
  await expect(dialog.getByRole("button", { name: "Depot löschen" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Abbrechen" }).click();

  await page.getByRole("button", { name: "+ Depot" }).click();
  await page.getByRole("button", { name: "Depot verwalten" }).click();
  await dialog.getByLabel("Name").fill("Wachstum");
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("tab", { name: "Wachstum" })).toBeVisible();

  await page.getByRole("button", { name: "Depot verwalten" }).click();
  await dialog.getByRole("button", { name: "Depot löschen" }).click();
  await expect(page.getByRole("tab", { name: "Wachstum" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Depot 1" })).toHaveAttribute("aria-selected", "true");
});
