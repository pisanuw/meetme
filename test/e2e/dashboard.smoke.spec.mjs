import { expect, test } from "@playwright/test";

test("dashboard shows meetings, booking links, and my bookings sections", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "u-dashboard", email: "owner@example.com", name: "Owner User" }),
    });
  });

  await page.route("**/api/meetings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        my_meetings: [
          {
            id: "mtg-1",
            title: "Planning Sync",
            description: "Sprint planning",
            meeting_type: "days_of_week",
            dates_or_days: ["Monday", "Wednesday"],
            respond_count: 1,
            invite_count: 2,
            is_finalized: false,
          },
        ],
        invited_meetings: [
          {
            id: "mtg-2",
            title: "Team Retro",
            description: "Weekly retro",
            meeting_type: "specific_dates",
            dates_or_days: ["2026-04-04"],
            respond_count: 0,
            invite_count: 3,
            creator_name: "Another Owner",
            is_finalized: false,
          },
        ],
      }),
    });
  });

  await page.route("**/api/bookings/event-types", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        public_page_slug: "owner-user",
        event_types: [
          {
            id: "evt-1",
            title: "Intro Call",
            description: "Quick intro",
            event_type: "one_on_one",
            duration_minutes: 30,
            day_start_time: "08:00",
            day_end_time: "20:00",
            timezone: "UTC",
            availability: { window_count: 5 },
          },
        ],
      }),
    });
  });

  await page.route("**/api/bookings/host", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bookings: [
          {
            id: "bk-1",
            event_title: "Intro Call",
            event_kind: "one_on_one",
            attendee_name: "Guest Person",
            date: "2026-04-05",
            start_time: "09:00",
            timezone: "UTC",
            status: "confirmed",
          },
        ],
      }),
    });
  });

  await page.route("**/api/bookings/mine", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bookings: [] }),
    });
  });

  await page.goto("/dashboard.html");

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Hello, Owner User")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Meetings I Created" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Meetings I'm Invited To" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Booking Links" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "My Bookings" })).toBeVisible();

  await expect(page.getByText("Planning Sync")).toBeVisible();
  await expect(page.getByText("Team Retro")).toBeVisible();
  await expect(page.getByText("Intro Call").first()).toBeVisible();
  await expect(page.getByText("Attendee: Guest Person")).toBeVisible();

  await expect(page.getByRole("link", { name: "+ New Meeting" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "View all" })).toHaveCount(0);
});