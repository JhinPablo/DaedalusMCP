import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8895",
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  },
  webServer: {
    command: "npx tsx scripts/browser-fixture.ts",
    url: "http://127.0.0.1:8895",
    reuseExistingServer: false,
  },
  outputDir: ".daedalus/playwright-results",
});
