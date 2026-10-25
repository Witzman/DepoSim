import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seen")) {
      for (const k of ["deposim-indicators", "deposim-chart"]) localStorage.removeItem(k);
      sessionStorage.setItem("seen", "1");
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Profi");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByTestId("chart")).not.toHaveAttribute("data-bars", "0");
}

const toggle = async (page: Page, name: string, on = true) => {
  const box = page.getByLabel(name, { exact: true });
  if (!(await box.isVisible())) await page.locator("summary", { hasText: "Indikatoren" }).click();
  await (on ? box.check() : box.uncheck());
};

test("a coarser timeframe folds the minute bars into fewer candles and is remembered", async ({ page }) => {
  await createSimulation(page);
  const chart = page.getByTestId("chart");
  await expect(chart).toHaveAttribute("data-timeframe", "1m");
  const minutes = Number(await chart.getAttribute("data-bars"));
  expect(minutes).toBeGreaterThan(5);

  await page.getByTestId("tf-15m").click();
  await expect(chart).toHaveAttribute("data-timeframe", "15m");
  await expect.poll(async () => Number(await chart.getAttribute("data-bars"))).toBeLessThan(minutes);
  await expect(page.getByTestId("tf-15m")).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-timeframe", "15m");
});

test("chart type and price scale can be switched, the legend shows the bar under the cursor", async ({ page }) => {
  await createSimulation(page);
  const chart = page.getByTestId("chart");
  await page.getByTestId("type-heikin").click();
  await expect(chart).toHaveAttribute("data-type", "heikin");
  await expect(page.getByTestId("ohlc")).toContainText("Heikin-Ashi");
  await page.getByTestId("type-line").click();
  await expect(chart).toHaveAttribute("data-type", "line");
  await page.getByTestId("scale-log").click();
  await expect(chart).toHaveAttribute("data-scale", "log");
  await page.getByTestId("scale-percent").click();
  await expect(chart).toHaveAttribute("data-scale", "percent");

  const ohlc = page.getByTestId("ohlc");
  await expect(ohlc).toContainText("SAP.DE");
  await expect(ohlc).toContainText("Vol");
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await expect(ohlc).toContainText("O");
});

test("ATR, Stochastic and OBV get their own panes, VWAP sits on the price", async ({ page }) => {
  await createSimulation(page);
  const chart = page.getByTestId("chart");
  await toggle(page, "VWAP (Tag)");
  await expect(chart).toHaveAttribute("data-panes", "1");
  await toggle(page, "Stochastik");
  await expect(chart).toHaveAttribute("data-panes", "2");
  await toggle(page, "ATR");
  await expect(chart).toHaveAttribute("data-panes", "3");
  await toggle(page, "OBV");
  await expect(chart).toHaveAttribute("data-panes", "4");
  await expect(chart).toHaveAttribute("data-indicators", "vwap,stoch,atr,obv");
  await toggle(page, "OBV", false);
  await toggle(page, "ATR", false);
  await toggle(page, "Stochastik", false);
  await expect(chart).toHaveAttribute("data-panes", "1");
});

test("the evaluation shows risk figures, the drawdown chart and the trade statistics", async ({ page }) => {
  await createSimulation(page);
  await page.getByLabel("Menge").fill("1");
  await expect(page.getByTestId("cost-total")).toBeVisible();
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();

  await page.getByRole("tab", { name: "Auswertung" }).click();
  await expect(page.getByTestId("risk")).toBeVisible();
  await expect(page.getByTestId("risk").locator("tbody tr").first()).toContainText("—"); // too few steps yet, no invented figures
  await expect(page.getByTestId("underwater").locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("underwater")).toHaveAttribute("data-series", "1");

  await page.getByLabel("Maßstab").selectOption("SAP.DE");
  await expect(page.getByTestId("relative")).toBeVisible();
});

test("switching the title and back shows that title's candles again, not the other one's", async ({ page }) => {
  await createSimulation(page);
  const close = async () => (await page.getByTestId("ohlc").innerText()).match(/S\s+([\d.,]+)/)![1];
  await expect(page.getByTestId("ohlc")).toContainText("SAP.DE");
  await expect(page.getByTestId("chart")).not.toHaveAttribute("data-bars", "0");
  // the candles of the title have settled when the same close has been read twice, 500 ms apart
  let sap = await close();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const again = await close();
    if (again === sap) break;
    sap = again;
  }
  await page.getByLabel("Wertpapier").selectOption("SIE.DE");
  await expect(page.getByTestId("ohlc")).toContainText("SIE.DE");
  await expect.poll(close).not.toBe(sap);
  await page.getByLabel("Wertpapier").selectOption("SAP.DE");
  await expect(page.getByTestId("ohlc")).toContainText("SAP.DE");
  await expect.poll(close).toBe(sap);
});
