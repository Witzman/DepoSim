import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Kennzahlen");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByLabel("Menge")).toBeEnabled();
}

test("the info button opens by keyboard, is described by its text and closes with Esc", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("tab", { name: "Auswertung" }).click();
  const button = page.getByTestId("hint-sharpe");
  await button.focus();
  await page.keyboard.press("Enter");
  const text = page.getByTestId("hint-text-sharpe");
  await expect(text).toContainText("ohne risikofreien Zins");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(button).toHaveAttribute("aria-describedby", /.+/);
  await page.keyboard.press("Escape");
  await expect(text).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("a fresh simulation says it is too early to tell, with the reason", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("tab", { name: "Auswertung" }).click();
  await expect(page.getByTestId("reliability").first()).toHaveText("zu früh zu sagen");
  await expect(page.getByTestId("reliability-note")).toContainText("weniger als 10 Werte");
});

test("the glossary opens from the palette, finds Calmar and closes with Esc", async ({ page }) => {
  await createSimulation(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("calmar");
  await page.getByRole("option", { name: /Kennzahlen erklärt/ }).click();
  const dialog = page.getByTestId("glossary");
  await expect(dialog).toBeVisible();
  await page.getByTestId("glossary-input").fill("Calmar");
  await expect(page.getByTestId("glossary-calmar")).toBeVisible();
  await expect(page.getByTestId("glossary-sharpe")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("the key G opens the glossary", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("heading", { name: "Depot" }).first().click();
  await page.keyboard.press("g");
  await expect(page.getByTestId("glossary")).toBeVisible();
});
