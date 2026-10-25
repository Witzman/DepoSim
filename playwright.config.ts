import { defineConfig } from "@playwright/test";

// The browser tests run against `server/src/dev-fake.ts`: the real app with made-up prices,
// so they need no network and do not depend on the market being open.
export default defineConfig({
  testDir: "web/e2e",
  timeout: 30_000,
  workers: 1,
  // The guided first steps (#37) are for a new person; the other specs start with them dismissed, guide.spec.ts with a clean browser.
  use: {
    baseURL: "http://127.0.0.1:3100", headless: true,
    storageState: { cookies: [], origins: [{ origin: "http://127.0.0.1:3100", localStorage: [{ name: "deposim-guide", value: '{"dismissed":true,"seen":[],"done":[]}' }] }] },
  },
  webServer: {
    command: "npm run build:web && npx tsx server/src/dev-fake.ts",
    url: "http://127.0.0.1:3100/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
