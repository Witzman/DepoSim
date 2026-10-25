import { expect, test } from "@playwright/test";

test("the sound is off at first, the choice survives a reload, and a missing audio API breaks nothing", async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).AudioContext; delete (window as any).webkitAudioContext; });
  await page.goto("/");
  await page.getByTestId("feedback-open").click();
  await expect(page.getByTestId("fb-sound")).not.toBeChecked();
  await expect(page.getByTestId("fb-haptics")).toBeChecked();
  await page.getByTestId("fb-sound").check();
  await page.getByTestId("fb-motion").check();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await page.getByTestId("feedback-open").click();
  await expect(page.getByTestId("fb-sound")).toBeChecked();
  await expect(page.getByTestId("fb-motion")).toBeChecked();
});

test("the system's reduced-motion setting is respected without any choice made", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
});

test("with sound on, a fill makes a tone, after the first interaction", async ({ page, request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
  await page.addInitScript(() => {
    (window as any).__tones = 0;
    localStorage.setItem("deposim-feedback", JSON.stringify({ sound: true, haptics: false, reducedMotion: false }));
    (window as any).AudioContext = class {
      currentTime = 0; destination = {};
      createOscillator() { (window as any).__tones++; return { frequency: {}, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
      resume() { return Promise.resolve(); }
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByLabel("Menge")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__tones)).toBe(0);
  await page.getByLabel("Menge").fill("1");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__tones)).toBeGreaterThan(0);
});
