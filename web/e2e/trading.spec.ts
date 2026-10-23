import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  // The server keeps its simulations between tests, and the app opens the newest on load.
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Handel");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  // The prices of the symbol arrive with the first snapshot.
  await expect(page.getByLabel("Menge")).toBeEnabled();
}

const euro = /\d[\d.]*,\d{2}\s€/;

test("the ticket shows what a buy would cost before it is confirmed", async ({ page }) => {
  await createSimulation(page);
  await page.getByLabel("Menge").fill("1");
  await expect(page.getByTestId("cost-commission")).toContainText(euro);
  await expect(page.getByTestId("cost-total")).toContainText(euro);
});

test("a market buy shows up as a position and takes cash, and a limit sell can be placed and deleted", async ({ page }) => {
  await createSimulation(page);
  await page.getByLabel("Menge").fill("1");
  await expect(page.getByTestId("cost-total")).toContainText(euro);
  await page.getByRole("button", { name: "Kaufen" }).click();

  const row = page.getByTestId("position-SAP.DE");
  await expect(row).toBeVisible();
  await expect(row).toContainText("1");
  const cash = await page.getByTestId("cash").textContent();
  expect(cash).not.toBe("10.000,00 €");
  expect(cash).toMatch(euro);

  // Sell limit 5 % above the last price: it stays open.
  const last = Number((await page.getByTestId("last-price").textContent())!.replace(/[^\d,]/g, "").replace(",", "."));
  await page.getByRole("button", { name: "Verkauf", exact: true }).click();
  await page.getByLabel("Art").selectOption("limit");
  await page.getByRole("spinbutton", { name: /^Limit/ }).fill((last * 1.05).toFixed(2));
  await page.getByLabel("Menge").fill("1");
  await page.getByRole("button", { name: "Verkaufen" }).click();
  const open = page.getByTestId("orders-open");
  await expect(open.getByRole("listitem")).toHaveCount(1);
  await open.getByRole("button", { name: "Löschen" }).click();
  await expect(open.getByRole("listitem")).toHaveCount(0);
});

test("a quantity of 0 shows the server's reason and cannot be sent", async ({ page }) => {
  await createSimulation(page);
  await page.getByLabel("Menge").fill("0");
  await expect(page.getByTestId("ticket-problem")).toContainText("Menge");
  await expect(page.getByRole("button", { name: "Kaufen" })).toBeDisabled();
});

test("after a reload the same simulation is open with the same position, cash and time", async ({ page }) => {
  await createSimulation(page);
  await page.getByLabel("Menge").fill("2");
  await expect(page.getByTestId("cost-total")).toContainText(euro);
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  const cash = await page.getByTestId("cash").textContent();
  const time = await page.getByTestId("sim-time").textContent();

  await page.reload();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  await expect(page.getByTestId("cash")).toHaveText(cash!);
  await expect(page.getByTestId("sim-time")).toHaveText(time!);
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible(); // paused
  await page.waitForTimeout(2000);
  await expect(page.getByTestId("sim-time")).toHaveText(time!);
});

test("the keys B and S pick the side and focus the quantity, Space starts and pauses", async ({ page }) => {
  await createSimulation(page);
  await page.keyboard.press("s");
  await expect(page.getByRole("button", { name: "Verkauf", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Menge")).toBeFocused();
  await page.getByLabel("Menge").blur();
  await page.keyboard.press("b");
  await expect(page.getByRole("button", { name: "Kauf", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Menge").blur();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
});

test("the watchlist shows each market as open or closed and switches the chart on a click", async ({ page }) => {
  await createSimulation(page);
  const watch = page.getByTestId("watchlist");
  await expect(watch.getByTestId("venue-XETRA")).toContainText("offen");
  await expect(watch.getByTestId("venue-US")).toContainText("geschlossen");
  await watch.getByRole("button", { name: /SIE\.DE/ }).click();
  await expect(page.getByLabel("Wertpapier")).toHaveValue("SIE.DE");
});
