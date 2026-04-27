/**
 * lib/meeting-validation.mjs — Pure validation helpers for meeting-related endpoints
 *
 * All functions return `null` on success or an `{ status, message }` object
 * when validation fails. Callers convert this to an HTTP error response.
 */
import { asArray, LIMITS } from "./utils-core.mjs";
import { validateEmail } from "./http.mjs";

const ALLOWED_MEETING_TYPES = new Set(["specific_dates", "days_of_week"]);
const ALLOWED_DAY_NAMES = new Set([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);
const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * Validate and normalise the POST /api/meetings create-meeting request body.
 *
 * @param {object} body - Parsed request body
 * @returns {{ error: null, data: object }|{ error: { status: number, message: string } }}
 */
export function validateCreateMeetingBody(body) {
  const normalizedTitle = String(body.title || "").trim();
  const normalizedDescription = String(body.description || "").trim();
  const normalizedMeetingType = String(body.meeting_type || "specific_dates").trim();
  const normalizedDatesOrDays = [
    ...new Set(
      asArray(body.dates_or_days)
        .map((v) => String(v || "").trim())
        .filter(Boolean)
    ),
  ];
  const normalizedTimezone = String(body.timezone || "UTC").trim();
  const startTime = body.start_time;
  const endTime = body.end_time;

  if (!normalizedTitle) {
    return { error: { status: 400, message: "Meeting title is required." } };
  }
  if (normalizedTitle.length > LIMITS.TITLE_MAX) {
    return {
      error: {
        status: 400,
        message: `Meeting title must be ${LIMITS.TITLE_MAX} characters or fewer.`,
      },
    };
  }
  if (normalizedDescription.length > LIMITS.DESCRIPTION_MAX) {
    return {
      error: {
        status: 400,
        message: `Description must be ${LIMITS.DESCRIPTION_MAX} characters or fewer.`,
      },
    };
  }
  if (!ALLOWED_MEETING_TYPES.has(normalizedMeetingType)) {
    return {
      error: {
        status: 400,
        message: "meeting_type must be either 'specific_dates' or 'days_of_week'.",
      },
    };
  }
  if (normalizedDatesOrDays.length === 0) {
    return { error: { status: 400, message: "Select at least one date or day." } };
  }
  if (normalizedMeetingType === "specific_dates") {
    const invalidDate = normalizedDatesOrDays.find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
    if (invalidDate) {
      return {
        error: {
          status: 400,
          message: `Invalid date value '${invalidDate}'. Expected YYYY-MM-DD.`,
        },
      };
    }
  } else {
    const invalidDay = normalizedDatesOrDays.find((d) => !ALLOWED_DAY_NAMES.has(d));
    if (invalidDay) {
      return { error: { status: 400, message: `Invalid day value '${invalidDay}'.` } };
    }
  }
  if (startTime && !TIME_RE.test(startTime)) {
    return { error: { status: 400, message: "start_time must be in HH:MM format." } };
  }
  if (endTime && !TIME_RE.test(endTime)) {
    return { error: { status: 400, message: "end_time must be in HH:MM format." } };
  }
  if (startTime && endTime && startTime >= endTime) {
    return { error: { status: 400, message: "end_time must be after start_time." } };
  }
  if (normalizedTimezone !== "UTC" && !new Set(Intl.supportedValuesOf("timeZone")).has(normalizedTimezone)) {
    return { error: { status: 400, message: "Invalid timezone value." } };
  }

  return {
    error: null,
    data: {
      normalizedTitle,
      normalizedDescription,
      normalizedMeetingType,
      normalizedDatesOrDays,
      normalizedTimezone,
      start_time: startTime,
      end_time: endTime,
    },
  };
}

/**
 * Validate the POST /api/meetings/:id/finalize request body.
 *
 * @param {object} body - Parsed request body
 * @returns {{ error: null, durationMinutes: number }|{ error: { status: number, message: string } }}
 */
export function validateFinalizeBody(body) {
  if (!body.date_or_day || !body.time_slot) {
    return {
      error: { status: 400, message: "Both 'date_or_day' and 'time_slot' are required to finalize." },
    };
  }
  const durationMinutes = Number.parseInt(body.duration_minutes || 60, 10);
  if (
    !Number.isFinite(durationMinutes) ||
    durationMinutes < LIMITS.DURATION_MIN ||
    durationMinutes > LIMITS.DURATION_MAX
  ) {
    return {
      error: {
        status: 400,
        message: `duration_minutes must be between ${LIMITS.DURATION_MIN} and ${LIMITS.DURATION_MAX}.`,
      },
    };
  }
  return { error: null, durationMinutes };
}

/**
 * Validate and normalise invite_emails from a create-meeting request.
 *
 * @param {string|string[]|undefined} inviteEmails - Raw invite_emails field
 * @param {string} creatorEmail - Normalised creator email (to exclude from invitees)
 * @returns {{ error: null, emails: string[] }|{ error: { status: number, message: string } }}
 */
export function validateInviteEmails(inviteEmails, creatorEmail) {
  if (!inviteEmails) return { error: null, emails: [] };

  const rawInviteEmails = Array.isArray(inviteEmails)
    ? inviteEmails.join(",")
    : String(inviteEmails);
  const rawEmails = rawInviteEmails.split(/[\n,]+/);
  const emails = [
    ...new Set(
      rawEmails.map((e) => validateEmail(e)).filter((e) => e && e !== creatorEmail)
    ),
  ];
  if (emails.length > LIMITS.MAX_INVITEES) {
    return {
      error: {
        status: 400,
        message: `You can invite at most ${LIMITS.MAX_INVITEES} people to one meeting.`,
      },
    };
  }
  return { error: null, emails };
}
