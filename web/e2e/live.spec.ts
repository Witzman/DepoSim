import { expect, test, type APIRequestContext } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  // The server keeps its simulations between tests, and the app opens the newest on load.
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

const TEN_BERLIN = 1792742400; // 2026-10-23 10:00 Berlin = 08:00 UTC; the test server's present starts at 13:00 UTC

async function make(request: APIRequest, body: Record<string, unknown>) {
  const res = await request.post("/api/simulations", { data: { name: "E2E", ...body } });
  expect(res.status()).toBe(201);
}
type APIRequest = APIRequestContext;

test("Live in the dialog turns off the date and time, and the simulation starts at the present", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel(/^Live/).check();
  await expect(page.getByLabel("Datum")).toBeDisabled();
  await expect(page.getByLabel("Uhrzeit (Berliner Zeit)")).toBeDisabled();
  await page.getByRole("button", { name: "Anlegen" }).click();

  await expect(page.getByTestId("clock-status")).toContainText("Live");
  await expect(page.getByTestId("sim-time")).toHaveText(/^23\.10\.2026, 14:[45]\d:\d\d$/); // 13:00 UTC minus 15 minutes, in Berlin time
  await expect(page.getByTestId("sim-list")).toContainText("Live");
});

test("a live simulation far behind the present catches up by itself, then reads Live, and its tempo is locked", async ({ page, request }) => {
  await make(request, { live: true, startAt: TEN_BERLIN });
  await page.goto("/");
  await expect(page.getByTestId("clock-status")).toContainText("Aufholen");
  await expect(page.getByTestId("clock-status")).toContainText("Std.");
  for (const t of ["1x", "5x", "30x", "60x"]) await expect(page.getByRole("button", { name: t, exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("clock-status")).toContainText("Live", { timeout: 20_000 });
  await expect(page.getByTestId("clock-status")).not.toContainText("Aufholen");
  await expect(page.getByTestId("sim-time")).toHaveText(/^23\.10\.2026, 14:[45]\d:\d\d$/);
});

test("a replay shows no catch-up line and keeps its tempo buttons", async ({ page, request }) => {
  await make(request, { startAt: TEN_BERLIN });
  await page.goto("/");
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByTestId("clock-status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "60x" })).toBeEnabled();
});

test("a replay at tempo 1 moves the clock (it used to stand still)", async ({ page, request }) => {
  await make(request, { startAt: TEN_BERLIN });
  await page.goto("/");
  const time = page.getByTestId("sim-time");
  await expect(time).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByRole("button", { name: "1x", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(time).not.toHaveText("23.10.2026, 10:00:00", { timeout: 5000 });
  await page.getByRole("button", { name: "Pause" }).click();
});
