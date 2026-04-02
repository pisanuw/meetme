import { expect, test } from "@playwright/test";

test("book flow redirects to confirmation with booking detail", async ({ page }) => {
  let capturedBookingPayload = null;
  let bookingStatus = "confirmed";
  let slotRequestCount = 0;

  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "u-booker", email: "booker@example.com", name: "Booker" }),
    });
  });

  await page.route("**/api/bookings/page/host-smoke", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        owner: { id: "host-1", email: "host@example.com", name: "Host Smoke" },
        event_types: [
          {
            id: "evt-smoke",
            title: "Intro Call",
            duration_minutes: 30,
            event_type: "one_on_one",
            timezone: "UTC",
            availability: {
              mode: "weekly",
              start_date: "2026-04-01",
              end_date: "2026-04-30",
            },
          },
          {
            id: "evt-social",
            title: "Social Chat",
            duration_minutes: 60,
            event_type: "one_on_one",
            timezone: "UTC",
            availability: {
              mode: "weekly",
              start_date: "2026-04-10",
              end_date: "2026-05-10",
            },
          },
        ],
      }),
    });
  });

  await page.route("**/api/bookings/page/host-smoke/slots**", async (route) => {
    slotRequestCount += 1;
    const url = new URL(route.request().url());
    const eventTypeId = url.searchParams.get("event_type_id");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        slots: eventTypeId === "evt-social" ? ["14:00"] : ["09:00"],
        blocked_by_calendar: [],
      }),
    });
  });

  await page.route("**/api/bookings/page/host-smoke/book", async (route) => {
    capturedBookingPayload = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        booking: {
          id: "bk-smoke-1",
          event_title: "Intro Call",
          date: "2026-04-06",
          start_time: "09:00",
          timezone: "UTC",
        },
      }),
    });
  });

  await page.route("**/api/bookings/bk-smoke-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        booking: {
          id: "bk-smoke-1",
          event_title: "Intro Call",
          date: "2026-04-06",
          start_time: "09:00",
          timezone: "UTC",
          host_name: "Host Smoke",
          attendee_name: "Booker",
          status: bookingStatus,
        },
      }),
    });
  });

  await page.route("**/api/bookings/bk-smoke-1/cancel", async (route) => {
    bookingStatus = "cancelled";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, booking: { id: "bk-smoke-1", status: "cancelled" } }),
    });
  });

  await page.goto("/book.html?host=host-smoke&event=evt-smoke");
  await expect(page.getByRole("heading", { name: /Book Time with Host Smoke/ })).toBeVisible();
  await expect(page.locator("#book-date")).toHaveValue("2026-04-01");

  await page.selectOption("#event-select", "evt-social");
  await expect(page.locator("#book-date")).toHaveValue("2026-04-10");
  await expect(page.getByRole("button", { name: "14:00" })).toBeVisible();

  await page.selectOption("#event-select", "evt-smoke");
  await expect(page.getByRole("button", { name: "09:00" })).toBeVisible();

  await page.getByRole("button", { name: "09:00" }).click();
  await page.getByRole("button", { name: "Book Selected Slot" }).click();

  await expect(page).toHaveURL(/\/booking-confirmation\.html\?id=bk-smoke-1/);
  await expect(page.getByText("Booking confirmed.")).toBeVisible();
  await expect(page.getByText("Intro Call")).toBeVisible();
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Cancel Booking" }).click();
  await expect(page.locator("#confirmation-subtitle")).toHaveText("Booking cancelled.");

  expect(capturedBookingPayload).toBeTruthy();
  expect(capturedBookingPayload.event_type_id).toBe("evt-smoke");
  expect(capturedBookingPayload.start_time).toBe("09:00");
  expect(slotRequestCount).toBeGreaterThanOrEqual(3);
});

test("host reminders action posts selected reminder window", async ({ page }) => {
  let capturedReminderPayload = null;
  let schedulerRunCalled = false;

  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "host-smoke", email: "admin@example.com", name: "Host Smoke", is_admin: true }),
    });
  });

  await page.route("**/api/bookings/host", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bookings: [
          {
            id: "bk-host-1",
            event_title: "Host Event",
            date: "2026-04-06",
            start_time: "09:00",
            timezone: "UTC",
            status: "confirmed",
            event_kind: "one_on_one",
            host_name: "Host Smoke",
            attendee_name: "Guest Smoke",
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

  await page.route("**/api/bookings/event-types", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        public_page_slug: "host-smoke",
        event_types: [
          {
            id: "evt-reminders",
            title: "Host Event",
            event_type: "one_on_one",
            duration_minutes: 30,
            timezone: "UTC",
            availability: { window_count: 1 },
          },
        ],
      }),
    });
  });

  await page.route("**/api/bookings/reminders/send", async (route) => {
    capturedReminderPayload = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        sent_count: 1,
        skipped_count: 0,
        failed_count: 0,
        reminder_booking_ids: ["bk-host-1"],
      }),
    });
  });

  await page.route("**/api/bookings/reminders/run-now", async (route) => {
    schedulerRunCalled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, host_count: 2, sent_count: 1, skipped_count: 1, failed_count: 0 }),
    });
  });

  await page.goto("/dashboard.html");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.locator("#reminder-window").selectOption("6");
  await page.getByRole("button", { name: "Send Reminders" }).click();

  await expect(page.locator("#bookings-toolbar-feedback")).toContainText("Sent 1 reminder.");
  await expect(page.locator("#bookings-toolbar-reminder-list")).toBeVisible();
  await expect(page.locator("#bookings-toolbar-reminder-list")).toContainText(
    "Guest Smoke · Host Event · 2026-04-06 09:00 UTC"
  );

  const schedulerButton = page.getByRole("button", { name: "Run Scheduler Now" });
  if (await schedulerButton.isVisible()) {
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await schedulerButton.click();
    await expect(page.locator("#bookings-toolbar-feedback")).toHaveText(
      "Scheduler run complete: hosts 2, sent 1, skipped 1, failed 0."
    );
  } else {
    expect(schedulerRunCalled).toBeFalsy();
  }

  expect(capturedReminderPayload).toBeTruthy();
  expect(capturedReminderPayload.within_hours).toBe(6);
});
