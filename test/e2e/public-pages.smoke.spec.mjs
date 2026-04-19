import { expect, test } from "@playwright/test";

test("index page loads anonymous create-meeting form", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create a meeting" })).toBeVisible();
  await expect(page.locator("#create-form")).toBeVisible();
  await expect(page.locator("#title")).toBeVisible();
  await expect(page.locator("#day-checkboxes .day-chip")).toHaveCount(7);
  // Sign-in link is offered as a secondary option in the nav + form.
  await expect(page.locator("#nav-anon a[href='/login.html']")).toBeVisible();
});

test("login page loads core auth controls", async ({ page }) => {
  await page.goto("/login.html");
  await expect(page.getByRole("heading", { name: "Welcome to MeetMe" })).toBeVisible();
  await expect(page.locator("#magic-link-form")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
});

test("create-meeting page renders form controls", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "u1", email: "owner@example.com", name: "Owner" }),
    });
  });
  await page.route("**/api/auth/profile", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ timezone: "UTC" }),
    });
  });

  await page.goto("/create-meeting.html");
  await expect(page.locator("#create-form")).toBeVisible();
  await expect(page.locator("#title")).toBeVisible();
  await expect(page.locator("#start_time option")).toHaveCount(72);
  await expect(page.locator("#start_time")).toHaveValue("08:00");
  await expect(page.locator("#day-checkboxes .day-chip")).toHaveCount(7);
  await expect(page.locator("#day-checkboxes input[type='checkbox']:checked")).toHaveCount(5);
});
