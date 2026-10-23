import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests. They run against E2E_BASE_URL (default: the production deployment) and never place
 * orders. Signed-in journeys run only when E2E_EMAIL and E2E_PASSWORD are set (a test account).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://traded-one.vercel.app",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
