import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Bedienung");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByLabel("Menge")).toBeEnabled();
}

test("the keys 1 to 4 set the tempo, but not while typing in a field", async ({ page }) => {
  await createSimulation(page);
  const tempo = (label: string) => page.getByRole("group", { name: "Tempo" }).getByRole("button", { name: label });
  await expect(tempo("1x")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("3");
  await expect(tempo("30x")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("4");
  await expect(tempo("60x")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("2");
  await expect(tempo("5x")).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Menge").fill("");
  await page.getByLabel("Menge").pressSequentially("3");
  await expect(page.getByLabel("Menge")).toHaveValue("3");
  await expect(tempo("5x")).toHaveAttribute("aria-pressed", "true");
});

test("the question mark opens a list of the shortcuts, and the palette finds it too", async ({ page }) => {
  await createSimulation(page);
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Tastenkürzel" });
  await expect(help).toBeVisible();
  for (const key of ["B", "S", "Leertaste", "1 – 4", "Strg + K", "?"]) await expect(help).toContainText(key);
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();

  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("palette-input").pressSequentially("kürzel");
  await page.keyboard.press("Enter");
  await expect(help).toBeVisible();
});
