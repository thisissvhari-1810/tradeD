import { expect, test } from "@playwright/test";

test.describe("signed out", () => {
  test("the sign-in page renders without console errors or sideways scrolling", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test("protected pages send a signed-out visitor to sign in", async ({ page }) => {
    for (const path of ["/chart", "/options", "/holdings", "/super-admin"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("account APIs refuse a signed-out request", async ({ request }) => {
    for (const path of ["/api/portfolio", "/api/orders", "/api/market/candles?symbol=NIFTY&timeframe=1d", "/api/super-admin/users"]) {
      const response = await request.get(path);
      expect([401, 403], path).toContain(response.status());
    }
  });

  test("the health check answers", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
  });
});
