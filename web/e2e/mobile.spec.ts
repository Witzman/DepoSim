import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.goto("/");
  // On a phone the picker sits inside a <details>; with no simulation yet it starts open.
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Handy");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByLabel("Menge")).toBeEnabled();
}

test.describe("phone, 390 x 844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("one column without sideways scrolling, a bottom bar with large buttons", async ({ page }) => {
    await createSimulation(page);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(wide).toBe(true);

    const bar = page.getByRole("toolbar");
    await expect(bar).toBeVisible();
    for (const name of ["Kaufen", "Verkaufen", "Start"]) {
      const box = await bar.getByRole("button", { name, exact: true }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const barBox = (await bar.boundingBox())!;
    expect(barBox.y + barBox.height).toBeGreaterThan(844 - 2);

    // Order of the sections: chart before ticket before depot before orders.
    const y = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    const chart = await y(".chart");
    const ticket = await y("form[aria-label='Orderticket']");
    const depot = await y("section[aria-label='Depot']");
    const orders = await y("section[aria-label='Aufträge']");
    const picker = await y("details:has(section[aria-label='Simulationen'])");
    expect(chart).toBeLessThan(ticket);
    expect(ticket).toBeLessThan(depot);
    expect(depot).toBeLessThan(orders);
    expect(orders).toBeLessThan(picker);
    expect((await page.locator(".chart").first().boundingBox())!.height).toBe(280);

    for (const loc of [page.getByLabel("Menge"), page.getByLabel("Art"), page.getByRole("button", { name: "Kauf", exact: true })]) {
      expect((await loc.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("Kaufen in the bar picks the side, the ticket places a market buy", async ({ page }) => {
    await createSimulation(page);
    await page.getByRole("button", { name: "Verkauf", exact: true }).click();
    await page.getByRole("toolbar").getByRole("button", { name: "Kaufen", exact: true }).click();
    await expect(page.getByRole("button", { name: "Kauf", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Menge").fill("1");
    await expect(page.getByTestId("cost-total")).toBeVisible();
    await page.getByRole("form", { name: "Orderticket" }).getByRole("button", { name: "Kaufen" }).click();
    await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("Start and Pause in the bar run the clock", async ({ page }) => {
    await createSimulation(page);
    const bar = page.getByRole("toolbar");
    await bar.getByRole("button", { name: "Start" }).click();
    await expect(bar.getByRole("button", { name: "Pause" })).toBeVisible();
    await bar.getByRole("button", { name: "Pause" }).click();
    await expect(bar.getByRole("button", { name: "Start" })).toBeVisible();
  });

  test("picker and watchlist are reachable through their details", async ({ page }) => {
    await createSimulation(page);
    const sims = page.locator("details", { has: page.locator("section[aria-label='Simulationen']") });
    const watch = page.locator("details", { has: page.locator("[data-testid='watchlist']") });
    await expect(watch).toHaveCount(1);
    await watch.locator("summary").first().click();
    await expect(page.getByTestId("watchlist")).toBeVisible();
    await sims.locator("summary").first().click();
    await expect(page.getByTestId("sim-list")).toBeVisible();
  });
});

test("the desktop viewport shows no bottom bar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSimulation(page);
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  await expect(page.locator("details", { has: page.locator("[data-testid='watchlist']") })).toHaveCount(0);
});
