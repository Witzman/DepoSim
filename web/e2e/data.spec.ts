import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test.describe("Datenzustand", () => {
  test("the light opens the view with grid, sources, jobs and size", async ({ page }) => {
    await page.goto("/");
    const light = page.getByTestId("data-status");
    await expect(light).toBeVisible();
    await light.click();
    const view = page.getByTestId("data-view");
    await expect(view.getByTestId("data-light")).toHaveAttribute("data-level", /green|yellow|red/);
    await expect(view.getByTestId("coverage-grid").getByRole("gridcell")).toHaveCount(30 * 19); // 18 values and the exchange rate
    await expect(view.getByTestId("source-table")).toContainText("Yahoo, Minutenbalken");
    await expect(view.getByTestId("job-sammlung-xetra")).toContainText("Tagessammlung Xetra");
    await expect(view.getByTestId("archive-facts")).toContainText("Minutenbalken");
    await view.getByRole("button", { name: "Schließen" }).click();
    await expect(view).toHaveCount(0);
  });

  test("a hand-started repair fills the grid, shows in the log and counts in the sources", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("data-status").click();
    const view = page.getByTestId("data-view");
    await expect(view.getByTestId("cell-SAP.DE-2026-10-22")).toHaveAttribute("data-state", "never");
    await view.getByTestId("run-luecken").click();
    await expect(view.getByTestId("cell-SAP.DE-2026-10-22")).toHaveAttribute("data-state", "complete", { timeout: 25_000 });
    await expect(view.getByTestId("run-log")).toContainText("Lückenreparatur");
    await expect(view.getByTestId("source-yahoo-minute").locator("[data-kind='200']")).not.toHaveText("0");
    // a click on a cell lists the minutes without a bar (the fake day is cut short by "now")
    await view.getByTestId("cell-SAP.DE-2026-10-23").click();
    await expect(view.getByTestId("gap-card")).toContainText("SAP.DE am 23.10.2026");
    // a Saturday needs nothing
    await view.getByTestId("cell-SAP.DE-2026-10-17").click();
    await expect(view.getByTestId("gap-card")).toContainText("Wochenende");
  });

  test("the palette opens the view", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("palette-open").click();
    await page.getByRole("combobox").fill("ampel");
    await page.getByRole("option", { name: /Datenzustand öffnen/ }).click();
    await expect(page.getByTestId("data-view")).toBeVisible();
  });

  test.describe("phone, 390 x 844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the view fits without sideways page scrolling and the cells can be tapped", async ({ page }) => {
      await page.goto("/");
      await page.getByTestId("data-status").click();
      const view = page.getByTestId("data-view");
      await expect(view.getByTestId("coverage-grid")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const cell = await view.getByTestId("cell-SAP.DE-2026-10-22").boundingBox();
      expect(cell!.width).toBeGreaterThanOrEqual(6);
      expect(cell!.height).toBeGreaterThanOrEqual(20);
      await view.getByTestId("cell-SAP.DE-2026-10-22").click();
      await expect(view.getByTestId("gap-card")).toBeVisible();
    });
  });
});
