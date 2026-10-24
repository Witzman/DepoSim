import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function openTab(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Langzeit");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await page.getByRole("tab", { name: "Langzeitvergleich" }).click();
}

test("Langzeitvergleich: Annahmen sichtbar, Daten laden, Kurven und Tabelle", async ({ page }) => {
  await openTab(page);
  await expect(page.getByTestId("longterm-assumptions")).toContainText("Ex-Tag");
  await expect(page.getByTestId("longterm-assumptions")).toContainText("Steuern");
  await expect(page.getByTestId("longterm-assumptions")).toContainText("kein Ratschlag");
  await expect(page.getByTestId("longterm-assumptions")).toContainText("Tageskurse");

  await page.getByRole("button", { name: "Daten laden" }).click();
  await expect(page.getByTestId("longterm-table")).toBeVisible();
  await expect(page.getByTestId("longterm-chart")).toHaveAttribute("data-series", "3");
  await expect(page.getByTestId("longterm-legend").locator("li")).toHaveCount(3);
  for (const key of ["ftse", "sp500", "msci"]) {
    const row = page.getByTestId(`longterm-row-${key}`);
    await expect(row).toContainText("€");
    await expect(row).toContainText(/[▲▼•]/);
  }
  await expect(page.getByTestId("longterm-row-ftse")).toContainText("VGWL.DE");
  await expect(page.getByTestId("longterm-row-sp500")).toContainText("VUSA.DE");
  await expect(page.getByTestId("longterm-row-msci")).toContainText("IQQW.DE");

  // Loaded data stays after a reload; the button asks nothing new from the source.
  await page.reload();
  await page.getByTestId("sim-list").getByText("Langzeit").click();
  await page.getByRole("tab", { name: "Langzeitvergleich" }).click();
  await expect(page.getByTestId("longterm-table")).toBeVisible();
});

test("Langzeitvergleich: Palette öffnet den Tab, bei 390 px gestapelt ohne Seitwärtsscroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openTab(page);
  await page.getByRole("button", { name: "Daten laden" }).click();
  await expect(page.getByTestId("longterm-table")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  const cell = page.getByTestId("longterm-row-ftse").locator("td").nth(1);
  expect(await cell.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
  await expect(page.getByTestId("longterm-assumptions")).toBeVisible();

  await page.getByRole("tab", { name: "Handel" }).click();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Langzeit");
  await page.getByRole("option", { name: "Langzeitvergleich öffnen" }).click();
  await expect(page.getByTestId("longterm")).toBeVisible();
});
