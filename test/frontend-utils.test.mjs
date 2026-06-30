/**
 * test/frontend-utils.test.mjs
 *
 * Unit tests for public/static/ui-utils.mjs — the pure utility functions
 * shared between the booking-availability and meeting page controllers.
 *
 * These functions contain the core frontend business logic:
 *   - Time arithmetic (toMinutes / fromMinutes)
 *   - Slot key encoding / decoding
 *   - Availability window serialization (collectWindowsFromSlots)
 *   - Availability window application (applyWindowsToSlots)
 *   - Heatmap colour mapping (heatColor)
 *   - Timezone conversion (convertSlotTime)
 *
 * Node's built-in test runner is used (node:test) — no extra dependencies.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toMinutes,
  fromMinutes,
  fmtTime12h,
  slotKey,
  splitSlotKey,
  normalizeAvailabilityResponse,
  applyWindowsToSlots,
  collectWindowsFromSlots,
  heatColor,
  convertSlotTime,
} from "../public/static/ui-utils.mjs";

// ── toMinutes ────────────────────────────────────────────────────────────────

describe("toMinutes", () => {
  it("converts midnight", () => assert.equal(toMinutes("00:00"), 0));
  it("converts noon", () => assert.equal(toMinutes("12:00"), 720));
  it("converts 23:59", () => assert.equal(toMinutes("23:59"), 1439));
  it("converts 09:15", () => assert.equal(toMinutes("09:15"), 555));
  it("handles missing value gracefully", () => assert.equal(toMinutes(""), 0));
  it("handles undefined gracefully", () => assert.equal(toMinutes(undefined), 0));
});

// ── fromMinutes ──────────────────────────────────────────────────────────────

describe("fromMinutes", () => {
  it("converts 0 to 00:00", () => assert.equal(fromMinutes(0), "00:00"));
  it("converts 720 to 12:00", () => assert.equal(fromMinutes(720), "12:00"));
  it("converts 555 to 09:15", () => assert.equal(fromMinutes(555), "09:15"));
  it("clamps negative values to 00:00", () => assert.equal(fromMinutes(-10), "00:00"));
  it("clamps values above 24h to 23:45 (default 15-min step)", () =>
    assert.equal(fromMinutes(9999), "23:45"));
  it("respects custom stepMinutes for clamping", () =>
    assert.equal(fromMinutes(9999, 30), "23:30"));
});

// ── toMinutes / fromMinutes round-trip ───────────────────────────────────────

describe("toMinutes / fromMinutes round-trip", () => {
  const times = ["00:00", "08:30", "12:00", "17:45", "23:00"];
  for (const t of times) {
    it(`round-trips ${t}`, () => assert.equal(fromMinutes(toMinutes(t)), t));
  }
});

// ── fmtTime12h ───────────────────────────────────────────────────────────────

describe("fmtTime12h", () => {
  it("formats midnight as 12:00 AM", () => assert.equal(fmtTime12h("00:00"), "12:00 AM"));
  it("formats noon as 12:00 PM", () => assert.equal(fmtTime12h("12:00"), "12:00 PM"));
  it("formats 09:30 as 9:30 AM", () => assert.equal(fmtTime12h("09:30"), "9:30 AM"));
  it("formats 13:45 as 1:45 PM", () => assert.equal(fmtTime12h("13:45"), "1:45 PM"));
  it("formats 23:59 as 11:59 PM", () => assert.equal(fmtTime12h("23:59"), "11:59 PM"));
});

// ── slotKey / splitSlotKey ───────────────────────────────────────────────────

describe("slotKey", () => {
  it("joins weekday and time with |", () =>
    assert.equal(slotKey("Monday", "09:00"), "Monday|09:00"));
  it("joins ISO date and time with |", () =>
    assert.equal(slotKey("2025-06-01", "14:30"), "2025-06-01|14:30"));
});

describe("splitSlotKey", () => {
  it("splits a weekday key", () =>
    assert.deepEqual(splitSlotKey("Monday|09:00"), { columnKey: "Monday", time: "09:00" }));
  it("splits a date key", () =>
    assert.deepEqual(splitSlotKey("2025-06-01|14:30"), {
      columnKey: "2025-06-01",
      time: "14:30",
    }));
  it("returns empty strings for malformed key", () =>
    assert.deepEqual(splitSlotKey("no-pipe"), { columnKey: "", time: "" }));
});

describe("slotKey / splitSlotKey round-trip", () => {
  const cases = [
    { col: "Monday", time: "09:15" },
    { col: "2025-12-31", time: "23:45" },
    { col: "Saturday", time: "00:00" },
  ];
  for (const { col, time } of cases) {
    it(`round-trips ${col} @ ${time}`, () =>
      assert.deepEqual(splitSlotKey(slotKey(col, time)), { columnKey: col, time }));
  }
});

// ── normalizeAvailabilityResponse ────────────────────────────────────────────

describe("normalizeAvailabilityResponse", () => {
  it("returns defaults for empty input", () =>
    assert.deepEqual(normalizeAvailabilityResponse(), {
      mode: "weekly",
      start_date: "",
      end_date: "",
      windows: [],
    }));

  it("preserves specific_dates mode", () =>
    assert.equal(normalizeAvailabilityResponse({ mode: "specific_dates" }).mode, "specific_dates"));

  it("normalises unknown mode to weekly", () =>
    assert.equal(normalizeAvailabilityResponse({ mode: "unknown" }).mode, "weekly"));

  it("replaces a non-array windows value with []", () =>
    assert.deepEqual(normalizeAvailabilityResponse({ windows: null }).windows, []));

  it("preserves a valid windows array", () => {
    const windows = [{ start_time: "09:00", end_time: "17:00" }];
    assert.deepEqual(normalizeAvailabilityResponse({ windows }).windows, windows);
  });
});

// ── applyWindowsToSlots ──────────────────────────────────────────────────────

describe("applyWindowsToSlots", () => {
  it("returns an empty Set for no windows", () => {
    const result = applyWindowsToSlots([], "weekly", ["Monday"]);
    assert.equal(result.size, 0);
  });

  it("fills slots for a single 1-hour window in weekly mode", () => {
    const windows = [{ day_of_week: "Monday", start_time: "09:00", end_time: "10:00" }];
    const result = applyWindowsToSlots(windows, "weekly", ["Monday"], 15);
    assert.equal(result.size, 4); // 09:00, 09:15, 09:30, 09:45
    assert.ok(result.has("Monday|09:00"));
    assert.ok(result.has("Monday|09:45"));
    assert.ok(!result.has("Monday|10:00")); // end is exclusive
  });

  it("fills slots for specific_dates mode", () => {
    const windows = [{ date: "2025-06-01", start_time: "08:00", end_time: "08:30" }];
    const result = applyWindowsToSlots(windows, "specific_dates", ["2025-06-01"], 15);
    assert.equal(result.size, 2);
    assert.ok(result.has("2025-06-01|08:00"));
    assert.ok(result.has("2025-06-01|08:15"));
  });

  it("ignores windows for columns not in the provided list", () => {
    const windows = [{ day_of_week: "Sunday", start_time: "10:00", end_time: "11:00" }];
    const result = applyWindowsToSlots(windows, "weekly", ["Monday", "Tuesday"], 15);
    assert.equal(result.size, 0);
  });

  it("skips windows where end <= start", () => {
    const windows = [{ day_of_week: "Monday", start_time: "10:00", end_time: "09:00" }];
    const result = applyWindowsToSlots(windows, "weekly", ["Monday"], 15);
    assert.equal(result.size, 0);
  });

  it("handles multiple columns and windows", () => {
    const windows = [
      { day_of_week: "Monday", start_time: "09:00", end_time: "09:30" },
      { day_of_week: "Wednesday", start_time: "14:00", end_time: "14:30" },
    ];
    const result = applyWindowsToSlots(windows, "weekly", ["Monday", "Wednesday"], 15);
    assert.equal(result.size, 4);
  });
});

// ── collectWindowsFromSlots ──────────────────────────────────────────────────

describe("collectWindowsFromSlots", () => {
  it("returns [] for an empty slot set", () =>
    assert.deepEqual(collectWindowsFromSlots(new Set(), "weekly", "UTC"), []));

  it("produces one window for contiguous slots", () => {
    const slots = new Set(["Monday|09:00", "Monday|09:15", "Monday|09:30", "Monday|09:45"]);
    const windows = collectWindowsFromSlots(slots, "weekly", "UTC", 15);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].start_time, "09:00");
    assert.equal(windows[0].end_time, "10:00");
    assert.equal(windows[0].day_of_week, "Monday");
    assert.equal(windows[0].timezone, "UTC");
  });

  it("splits non-contiguous slots into separate windows", () => {
    const slots = new Set([
      "Monday|09:00",
      "Monday|09:15",
      // gap
      "Monday|10:00",
      "Monday|10:15",
    ]);
    const windows = collectWindowsFromSlots(slots, "weekly", "UTC", 15);
    assert.equal(windows.length, 2);
    assert.equal(windows[0].start_time, "09:00");
    assert.equal(windows[0].end_time, "09:30");
    assert.equal(windows[1].start_time, "10:00");
    assert.equal(windows[1].end_time, "10:30");
  });

  it("uses date key for specific_dates mode", () => {
    const slots = new Set(["2025-06-01|09:00", "2025-06-01|09:15"]);
    const windows = collectWindowsFromSlots(slots, "specific_dates", "America/Los_Angeles", 15);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].date, "2025-06-01");
    assert.equal(windows[0].timezone, "America/Los_Angeles");
    assert.equal(windows[0].day_of_week, undefined);
  });
});

// ── applyWindowsToSlots / collectWindowsFromSlots round-trip ─────────────────

describe("applyWindowsToSlots / collectWindowsFromSlots round-trip", () => {
  it("reconstructs the same windows after apply → collect", () => {
    const original = [
      { day_of_week: "Tuesday", start_time: "09:00", end_time: "11:00", timezone: "UTC" },
      { day_of_week: "Friday", start_time: "14:00", end_time: "15:00", timezone: "UTC" },
    ];
    const columnKeys = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const applied = applyWindowsToSlots(original, "weekly", columnKeys, 15);
    const collected = collectWindowsFromSlots(applied, "weekly", "UTC", 15);

    // Sort both for comparison
    const sortFn = (a, b) =>
      `${a.day_of_week}${a.start_time}`.localeCompare(`${b.day_of_week}${b.start_time}`);
    const sortedOriginal = [...original].map((w) => ({ ...w })).sort(sortFn);
    const sortedCollected = [...collected].sort(sortFn);

    assert.equal(sortedCollected.length, sortedOriginal.length);
    sortedOriginal.forEach((orig, i) => {
      assert.equal(sortedCollected[i].day_of_week, orig.day_of_week);
      assert.equal(sortedCollected[i].start_time, orig.start_time);
      assert.equal(sortedCollected[i].end_time, orig.end_time);
    });
  });
});

// ── heatColor ────────────────────────────────────────────────────────────────

describe("heatColor", () => {
  it("returns grey for 0 votes", () => assert.equal(heatColor(0, 10), "#f5f5f5"));
  it("returns grey for null votes", () => assert.equal(heatColor(null, 10), "#f5f5f5"));
  it("returns lightest green for 1/10 votes (ratio 0.1)", () =>
    assert.equal(heatColor(1, 10), "#e8f5e9"));
  it("returns light green for 3/10 votes (ratio 0.3)", () =>
    assert.equal(heatColor(3, 10), "#c8e6c9"));
  it("returns medium green for 6/10 votes (ratio 0.6)", () =>
    assert.equal(heatColor(6, 10), "#81c784"));
  it("returns strong green for 8/10 votes (ratio 0.8)", () =>
    assert.equal(heatColor(8, 10), "#4caf50"));
  it("returns darkest green for unanimous vote", () => assert.equal(heatColor(10, 10), "#2e7d32"));
  it("caps ratio at 1 for over-invited scenarios", () =>
    assert.equal(heatColor(15, 10), "#2e7d32"));
  it("handles totalParticipants=0 without divide-by-zero", () =>
    assert.equal(heatColor(5, 0), "#2e7d32"));
});

// ── convertSlotTime ──────────────────────────────────────────────────────────

describe("convertSlotTime", () => {
  it("returns null for same timezone", () =>
    assert.equal(
      convertSlotTime("2025-06-01", "09:00", "America/New_York", "America/New_York"),
      null
    ));

  it("returns null for a non-date string", () =>
    assert.equal(convertSlotTime("Monday", "09:00", "UTC", "America/New_York"), null));

  it("converts UTC to US/Eastern (UTC-5 in winter)", () => {
    // 2025-01-15 14:00 UTC → 09:00 Eastern (UTC-5)
    const result = convertSlotTime("2025-01-15", "14:00", "UTC", "America/New_York");
    assert.equal(result, "09:00");
  });

  it("converts US/Eastern to UTC (UTC-5 in winter)", () => {
    // 2025-01-15 09:00 Eastern → 14:00 UTC
    const result = convertSlotTime("2025-01-15", "09:00", "America/New_York", "UTC");
    assert.equal(result, "14:00");
  });

  it("handles US DST correctly (summer, UTC-4)", () => {
    // 2025-07-01 13:00 UTC → 09:00 Eastern (UTC-4 in summer)
    const result = convertSlotTime("2025-07-01", "13:00", "UTC", "America/New_York");
    assert.equal(result, "09:00");
  });

  it("converts between two non-UTC timezones", () => {
    // 2025-06-01 09:00 Pacific (UTC-7) → 12:00 Eastern (UTC-4)
    const result = convertSlotTime(
      "2025-06-01",
      "09:00",
      "America/Los_Angeles",
      "America/New_York"
    );
    assert.equal(result, "12:00");
  });

  it("returns null on invalid timezone", () =>
    assert.equal(convertSlotTime("2025-06-01", "09:00", "Not/ATimezone", "UTC"), null));
});
