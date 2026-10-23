import { expect, test, type Page } from "@playwright/test";

/**
 * Responsive checks across phone, tablet and desktop sizes (see the projects in playwright.config.ts).
 * Signed-in journeys need a test account (E2E_EMAIL / E2E_PASSWORD); nothing here places a broker order.
 */

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const signedIn = Boolean(email && password);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email!);
  await page.locator('input[type="password"]').fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

/**
 * Controls that stick out of the screen sideways. Rows that scroll sideways on purpose (chips, tool
 * strips) are skipped: what matters is that nothing is cut off with no way to reach it.
 */
async function offscreenControls(page: Page) {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const scrollsSideways = (node: Element | null): boolean => {
      for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if ((style.overflowX === "auto" || style.overflowX === "scroll") && current.scrollWidth > current.clientWidth) return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const node of document.querySelectorAll("button, a[href], input, select, [role='tab']")) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden") continue;
      if ((rect.right > width + 1 || rect.left < -1) && !scrollsSideways(node)) {
        out.push(`${node.tagName.toLowerCase()} "${(node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 40)}" at ${Math.round(rect.left)}–${Math.round(rect.right)}`);
      }
    }
    if (document.documentElement.scrollWidth > width + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${width}px)`);
    return out;
  });
}

const isPhoneOrTablet = (page: Page) => (page.viewportSize()?.width ?? 1366) < 1024;

test("sign-in page fits the screen", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(await offscreenControls(page)).toEqual([]);
});

test.describe("signed in", () => {
  test.skip(!signedIn, "Set E2E_EMAIL and E2E_PASSWORD (a test account) in .env.e2e.local to run signed-in journeys.");

  test("every primary screen fits the width, and the bottom bar never covers content", async ({ page }) => {
    await signIn(page);
    for (const path of ["/", "/watchlist", "/chart?symbol=NIFTY", "/positions", "/holdings", "/orders", "/options", "/markets", "/funds"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      expect(await offscreenControls(page), `controls off screen on ${path}`).toEqual([]);
      if (isPhoneOrTablet(page)) {
        const bar = page.locator('nav[aria-label="Main"]').last();
        await expect(bar).toBeVisible();
        const barBox = await bar.boundingBox();
        const mainBox = await page.locator("main").boundingBox();
        expect(mainBox && barBox && mainBox.y + mainBox.height <= barBox.y + 1, `main content ends above the bottom bar on ${path}`).toBeTruthy();
      }
    }
  });

  test("bottom navigation reaches the five primary destinations", async ({ page }) => {
    test.skip(!isPhoneOrTablet(page), "The bottom bar is for phones and tablets.");
    await signIn(page);
    const bar = page.locator('nav[aria-label="Main"]').last();
    for (const [label, url] of [["Watchlist", /\/watchlist/], ["Trade", /\/chart/], ["Positions", /\/positions/], ["Portfolio", /\/holdings/], ["Home", /\/$/]] as const) {
      const link = bar.getByRole("link", { name: label });
      if (!(await link.count())) continue; // a destination the account's permissions leave out
      await link.click();
      await expect(page).toHaveURL(url);
      await expect(link).toHaveAttribute("aria-current", "page");
    }
    await page.getByRole("button", { name: "All pages" }).click();
    await expect(page.getByRole("dialog", { name: "All pages" })).toBeVisible();
    await page.getByRole("button", { name: "Close menu" }).click();
  });

  test("chart: timeframes, the drawing sheet, drawing by touch, and rotation", async ({ page }) => {
    await signIn(page);
    await page.goto("/chart?symbol=NIFTY");
    const canvas = page.locator("canvas").first();
    await expect(canvas.or(page.getByText("Chart data is unavailable"))).toBeVisible({ timeout: 30_000 });
    for (const span of ["5m", "1D"]) {
      await page.getByRole("button", { name: span, exact: true }).first().click();
      await expect(canvas.or(page.getByText("Chart data is unavailable"))).toBeVisible({ timeout: 30_000 });
    }
    if (!(await canvas.isVisible())) test.skip(true, "No candles from the provider right now; drawing needs a chart.");
    if (!isPhoneOrTablet(page)) return;

    // The chart takes most of the screen on phones.
    const viewport = page.viewportSize()!;
    const chartBox = (await page.locator("canvas").first().boundingBox())!;
    expect(chartBox.height).toBeGreaterThan(viewport.height * 0.35);

    // Drawing tools open as a bottom sheet; a trend line is placed with one finger.
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Drawing tools" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Trend line", exact: true }).click();
    await expect(sheet).toBeHidden();
    const x = chartBox.x + chartBox.width * 0.3;
    const y = chartBox.y + chartBox.height * 0.4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + chartBox.width * 0.3, y + 30, { steps: 8 });
    await page.mouse.up();
    // A placed drawing can be undone from the sheet's actions.
    await page.getByRole("button", { name: /Draw|Trend line/ }).first().click();
    await sheet.getByRole("tab", { name: "Actions" }).click();
    await expect(sheet.getByRole("button", { name: "Undo" })).toBeEnabled();
    await sheet.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("button", { name: "Close drawing tools" }).click();

    // The page itself never scrolls while the chart is touched.
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);

    // Rotating the phone resizes the chart to the new width.
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await expect.poll(async () => (await page.locator("canvas").first().boundingBox())?.width ?? 0).toBeGreaterThan(viewport.width);
    expect(await offscreenControls(page)).toEqual([]);
    await page.setViewportSize(viewport);
  });

  test("option chain: a tap on a call shows Buy, and Buy opens the order ticket", async ({ page }) => {
    await signIn(page);
    await page.goto("/options?symbol=NIFTY");
    const strike = page.locator('[role="row"] [role="cell"]').first();
    await expect(strike.or(page.getByText(/unavailable|No option/i).first())).toBeVisible({ timeout: 30_000 });
    if (!(await strike.isVisible())) test.skip(true, "The option chain is not available right now.");
    const buy = page.getByRole("button", { name: /^Buy \d/ }).first();
    if ((page.viewportSize()?.width ?? 1366) < 600) {
      await page.locator('[role="row"]').nth(3).locator("div").first().click();
      await expect(buy).toBeVisible();
    } else {
      await page.locator('[role="row"]').nth(3).locator("div").first().hover();
    }
    await buy.click();
    const ticket = page.getByRole("dialog").or(page.locator("aside").filter({ hasText: /Lots|Quantity/ })).first();
    await expect(ticket).toBeVisible();
    expect(await offscreenControls(page)).toEqual([]);
  });
});
