/* global document */
import { expect, test } from "@playwright/test";

test.use({
  hasTouch: true,
  viewport: { width: 390, height: 844 },
});

async function mockAvailabilityPageApis(page) {
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
      body: JSON.stringify({
        event_types: [{
          id: "evt-touch",
          title: "Touch Test Event",
          event_type: "one_on_one",
          duration_minutes: 30,
          day_start_time: "08:00",
          day_end_time: "20:00",
          group_capacity: 1,
          timezone: "UTC",
        }],
      }),
    });
  });
  await page.route("**/api/bookings/availability?event_type_id=evt-touch", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "weekly", start_date: "2026-04-01", end_date: "2026-04-30", windows: [] }),
    });
  });
}

test("mobile vertical touch movement does not change availability selections", async ({ page }) => {
  await mockAvailabilityPageApis(page);
  await page.goto("/booking-availability.html?eventType=evt-touch");
  await expect(page.locator(".ag-cell").first()).toBeVisible();
  await expect(page.locator('.ag-cell[data-time="10:00"]').first()).toBeVisible();

  const result = await page.evaluate(() => {
    const grid = document.getElementById("availability-grid");
    const cell = document.querySelector('.ag-cell[data-time="10:00"]');
    if (!grid || !cell) return null;

    const rect = cell.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    function fireTouch(type, cx, cy) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touch = {
        identifier: 1,
        target: cell,
        clientX: cx,
        clientY: cy,
        pageX: cx,
        pageY: cy,
        screenX: cx,
        screenY: cy,
      };
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [touch] });
      Object.defineProperty(event, "targetTouches", { value: type === "touchend" ? [] : [touch] });
      Object.defineProperty(event, "changedTouches", { value: [touch] });
      grid.dispatchEvent(event);
      return event.defaultPrevented;
    }

    const originalElementFromPoint = document.elementFromPoint.bind(document);
    document.elementFromPoint = () => cell;

    let startPrevented = false;
    let movePrevented = false;
    try {
      startPrevented = fireTouch("touchstart", x, y);
      movePrevented = fireTouch("touchmove", x, y + 80);
      fireTouch("touchend", x, y + 80);
    } finally {
      document.elementFromPoint = originalElementFromPoint;
    }

    return {
      startPrevented,
      movePrevented,
      selectedCount: document.querySelectorAll(".ag-cell.mine-selected").length,
      summaryText: document.getElementById("availability-selection-summary")?.textContent || "",
    };
  });

  expect(result).not.toBeNull();
  expect(result.startPrevented).toBe(false);
  expect(result.movePrevented).toBe(false);
  expect(result.selectedCount).toBe(0);
  expect(result.summaryText).toContain("No slots selected yet.");
});
