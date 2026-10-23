import { existsSync, readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// A local, never-committed .env.e2e.local may hold the test account (E2E_EMAIL, E2E_PASSWORD).
if (existsSync(".env.e2e.local")) {
  for (const line of readFileSync(".env.e2e.local", "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const phone = (width: number, height: number) => ({ ...devices["Pixel 7"], viewport: { width, height }, screen: { width, height } });

/**
 * Browser tests. They run against E2E_BASE_URL (default: the production deployment) and never place
 * broker orders. Signed-in journeys run only when E2E_EMAIL and E2E_PASSWORD are set (a test account);
 * paper trades are placed only when E2E_PAPER_TRADES=1 as well.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://traded-one.vercel.app",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
    { name: "phone-320", use: phone(320, 568), testMatch: /mobile\.spec/ },
    { name: "phone-360", use: phone(360, 800), testMatch: /mobile\.spec/ },
    { name: "phone-375", use: phone(375, 812), testMatch: /mobile\.spec/ },
    { name: "phone-390", use: phone(390, 844), testMatch: /mobile\.spec/ },
    { name: "phone-430", use: phone(430, 932), testMatch: /mobile\.spec/ },
    { name: "tablet-portrait", use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 }, hasTouch: true }, testMatch: /mobile\.spec/ },
    { name: "tablet-landscape", use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 }, hasTouch: true }, testMatch: /mobile\.spec/ },
    { name: "desktop-1920", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } }, testMatch: /mobile\.spec/ },
  ],
});
