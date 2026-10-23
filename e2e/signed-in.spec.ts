import { expect, test, type Page } from "@playwright/test";

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.skip(!email || !password, "Set E2E_EMAIL and E2E_PASSWORD (a test account) to run signed-in journeys.");

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email!);
  await page.locator('input[type="password"]').fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("the chart loads candles or a clean, retryable error, across timeframes", async ({ page }) => {
  await signIn(page);
  await page.goto("/chart?symbol=NIFTY");
  for (const span of ["1m", "1D", "1W"]) {
    await page.getByRole("button", { name: span, exact: true }).first().click();
    const canvas = page.locator("canvas").first();
    const problem = page.getByText("Chart data is unavailable");
    await expect(canvas.or(problem)).toBeVisible({ timeout: 30_000 });
    // Raw provider text and request details never reach the screen.
    await expect(page.getByText(/Missing required fields|securityId=/)).toHaveCount(0);
    if (await problem.isVisible()) await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  }
});

test("the watchlist panel starts closed and the Watchlist button opens it", async ({ page }) => {
  await signIn(page);
  await page.goto("/chart?symbol=NIFTY");
  const toggle = page.getByRole("button", { name: "Watchlist" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tablist", { name: "Side panel" })).toBeVisible();
});

test("the Strategy panel opens and closes without placing anything", async ({ page }) => {
  await signIn(page);
  await page.goto("/chart?symbol=NIFTY");
  await page.getByRole("button", { name: "Strategy" }).click();
  await expect(page.getByRole("region", { name: "Strategy" }).or(page.locator('section[aria-label="Strategy"]'))).toBeVisible();
  await page.getByRole("button", { name: "Close strategy panel" }).click();
});
