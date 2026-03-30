import { expect, test } from "@playwright/test";

test("booking setup page loads and displays event type form", async ({ page }) => {
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
  await page.route("**/api/bookings/event-types", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ event_types: [] }),
    });
  });
  await page.goto("/booking-setup.html");
  await expect(page.getByRole("heading", { name: "Event Types" })).toBeVisible();
  await expect(page.locator("#event-type-form")).toBeVisible();
  await expect(page.locator("#event-title")).toBeVisible();
  await expect(page.locator("#event-description")).toBeVisible();
});

test("booking setup page does not show event types header when none exist", async ({ page }) => {
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
  await page.route("**/api/bookings/event-types", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ event_types: [] }),
    });
  });
  await page.goto("/booking-setup.html");
  // The header should not be present in the DOM
  await expect(page.locator("#event-types-header")).toHaveCount(0);
});

test("booking availability page loads and displays event type select", async ({ page }) => {
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
  await page.route("**/api/bookings/event-types", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ event_types: [{ id: "evt-1", title: "Test Event", event_type: "one_on_one", duration_minutes: 30, group_capacity: 1, timezone: "UTC" }] }),
    });
  });
  await page.route("**/api/bookings/availability?event_type_id=evt-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "weekly", start_date: "2026-04-01", end_date: "2026-04-30", windows: [] }),
    });
  });
  await page.goto("/booking-availability.html?eventType=evt-1");
  await expect(page.getByRole("heading", { name: "Availability" })).toBeVisible();
  await expect(page.locator("#availability-event-type")).toBeVisible();
});
