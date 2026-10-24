import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Indikatoren");
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

test("indicators can be switched on and off, RSI and MACD get their own panes, the choice survives a reload", async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("seen")) { localStorage.removeItem("deposim-indicators"); sessionStorage.setItem("seen", "1"); } });
  await createSimulation(page);
  const chart = page.getByTestId("chart");
  await expect(chart).toHaveAttribute("data-indicators", "");
  await expect(chart).toHaveAttribute("data-panes", "1");

  await toggle(page, "SMA");
  await expect(chart).toHaveAttribute("data-indicators", "sma");
  await expect(chart).not.toHaveAttribute("data-bars", "0");
  await expect(chart).toHaveAttribute("data-panes", "1");

  await toggle(page, "RSI");
  await expect(chart).toHaveAttribute("data-indicators", "sma,rsi");
  await expect(chart).toHaveAttribute("data-panes", "2");

  await toggle(page, "MACD");
  await expect(chart).toHaveAttribute("data-panes", "3");

  await page.reload();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-indicators", "sma,rsi,macd");
  await expect(page.getByTestId("chart")).toHaveAttribute("data-panes", "3");

  await toggle(page, "RSI", false);
  await toggle(page, "MACD", false);
  await toggle(page, "SMA", false);
  await expect(page.getByTestId("chart")).toHaveAttribute("data-indicators", "");
  await expect(page.getByTestId("chart")).toHaveAttribute("data-panes", "1");
  await expect(page.getByTestId("chart")).not.toHaveAttribute("data-bars", "0");
});
