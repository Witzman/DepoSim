import { expect, test, type Page } from "@playwright/test";

// The fake search (server/src/dev-fake.ts) finds BMW.DE and AMZN, neither is in the starting list.
test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
  for (const symbol of ["BMW.DE", "AMZN"]) await request.delete(`/api/watchlist/${symbol}`); // 404 when not there
});

async function createSimulation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Suche");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByLabel("Menge")).toBeEnabled();
}

test("Ctrl+K opens the palette with the focus in its field, also from inside another field, and Esc closes it", async ({ page }) => {
  await createSimulation(page);
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toBeHidden();

  await page.getByLabel("Menge").focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette")).toBeVisible();
});

test("B, S and Space do not act while the palette is open", async ({ page }) => {
  await createSimulation(page);
  const before = await page.getByTestId("sim-time").textContent();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("b s ");
  await expect(page.getByTestId("palette-input")).toHaveValue("b s ");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sim-time")).toHaveText(before!); // the clock did not start
});

test("a title is found, added, traded, and then cannot be removed while it is held", async ({ page }) => {
  await createSimulation(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").pressSequentially("bmw");
  const hit = page.getByRole("option", { name: /BMW\.DE/ });
  await expect(hit).toContainText("Neu hinzufügen");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toBeHidden();

  await expect(page.getByTestId("watchlist").getByText("BMW.DE")).toBeVisible();
  await expect(page.getByLabel("Wertpapier", { exact: true })).toHaveValue("BMW.DE");
  await expect(page.getByTestId("last-price")).toBeVisible();

  await page.getByLabel("Menge").fill("1");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-BMW.DE")).toBeVisible();

  await page.getByRole("button", { name: "BMW.DE entfernen" }).click();
  await expect(page.getByRole("status").filter({ hasText: /gehalten/ })).toBeVisible();
  await expect(page.getByTestId("watchlist").getByText("BMW.DE")).toBeVisible();
});

test("an added title that nobody holds can be removed, and a title in the list is selected from the palette", async ({ page }) => {
  await createSimulation(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").pressSequentially("amzn");
  await expect(page.getByRole("option", { name: /AMZN/ })).toContainText("Neu hinzufügen");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("watchlist").getByText("AMZN")).toBeVisible();

  await page.getByRole("button", { name: "AMZN entfernen" }).click();
  await expect(page.getByTestId("watchlist").getByText("AMZN")).toHaveCount(0);

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").pressSequentially("siemens");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Wertpapier", { exact: true })).toHaveValue("SIE.DE");
});
