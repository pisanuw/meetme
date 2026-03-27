import { expect, test } from "@playwright/test";

test("create meeting submit posts payload and redirects", async ({ page }) => {
  let capturedBody = null;

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
      body: JSON.stringify({ timezone: "UTC", calendar_connected: false }),
    });
  });

  await page.route("**/api/meetings", async (route) => {
    if (route.request().method() === "POST") {
      capturedBody = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, meeting_id: "smoke-123" }),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/meetings/smoke-123", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        meeting: {
          id: "smoke-123",
          title: "Smoke Meeting",
          description: "",
          meeting_type: "days_of_week",
          dates_or_days: ["Monday"],
          start_time: "09:00",
          end_time: "10:00",
          timezone: "UTC",
          is_finalized: false,
          finalized_date: null,
          finalized_slot: null,
          duration_minutes: 60,
          note: "",
        },
        time_slots: ["09:00", "09:15", "09:30", "09:45"],
        my_slots: [],
        slot_counts: {},
        total_invited: 1,
        is_creator: true,
        participants: [],
        respond_count: 0,
        invite_count: 1,
      }),
    });
  });

  await page.goto("/create-meeting.html");

  await page.fill("#title", "Smoke Meeting");
  await page.fill("#description", "Pre-deploy smoke flow");
  await page.fill("#invite_emails", "friend@example.com");
  await page.click("button[type='submit']");

  await expect(page).toHaveURL(/\/meeting\.html\?id=smoke-123/);

  expect(capturedBody).toBeTruthy();
  expect(capturedBody.title).toBe("Smoke Meeting");
  expect(capturedBody.meeting_type).toBe("days_of_week");
  expect(capturedBody.dates_or_days.length).toBeGreaterThan(0);
});
