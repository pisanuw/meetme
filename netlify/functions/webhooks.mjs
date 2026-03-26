/**
 * webhooks.mjs — Inbound webhook handlers for third-party services
 *
 * Routes handled:
 *   POST /api/webhooks/resend?secret=<RESEND_WEBHOOK_SECRET>
 *       Receives delivery events from Resend (bounce, complaint) and notifies
 *       the meeting creator when one of their invitation emails was undeliverable.
 *
 * Security: requests are authenticated via a shared secret passed as a query
 * parameter that must match the RESEND_WEBHOOK_SECRET environment variable.
 * Configure the webhook URL in the Resend dashboard → Webhooks.
 *
 * Event flow:
 *   Resend → POST /api/webhooks/resend?secret=...
 *     → verify secret
 *     → look up email_records blob by Resend email ID
 *     → send notification email to meeting creator
 *     → persist event for admin audit log
 */
import { getDb, getEnv, safeJson, log, logRequest, persistEvent, sendEmail, jsonResponse, errorResponse, escapeHtml } from "./utils.mjs";

const FN = "webhooks";

// Top-level entry point — catch-all so webhook delivery always gets a response.
export default async (req, context) => {
  try {
    return await handleWebhook(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return errorResponse(500, "Internal server error.");
  }
};

async function handleWebhook(req, context) {
  logRequest(FN, req);

  const url = new URL(req.url);
  const path = context.params["0"] || "";

  // ── POST /api/webhooks/resend ─────────────────────────────────────────────
  if (req.method === "POST" && path === "resend") {
    // Step 1: Verify the shared secret before processing any payload.
    // The secret is embedded in the webhook URL configured in Resend's dashboard.
    const expectedSecret = getEnv("RESEND_WEBHOOK_SECRET", "");
    const providedSecret  = url.searchParams.get("secret") || "";

    if (!expectedSecret) {
      log("warn", FN, "RESEND_WEBHOOK_SECRET is not set — webhook rejected");
      return errorResponse(500, "Webhook secret not configured on server.");
    }
    if (!providedSecret || providedSecret !== expectedSecret) {
      log("warn", FN, "resend webhook secret mismatch");
      return errorResponse(403, "Invalid webhook secret.");
    }

    // Step 2: Parse the event body sent by Resend.
    const body = await safeJson(req);
    if (!body) {
      log("warn", FN, "resend webhook body is not valid JSON");
      return errorResponse(400, "Invalid JSON body.");
    }

    const eventType = body.type || "";
    const emailId   = body.data?.email_id || body.data?.id || "";
    const toList    = body.data?.to || [];
    const toEmail   = Array.isArray(toList) ? toList[0] : toList;

    log("info", FN, "resend webhook received", { eventType, emailId, to: toEmail });
    await persistEvent("info", FN, "resend webhook", { eventType, emailId, to: toEmail });

    // Step 3: Only act on hard bounces and spam complaints.
    // Other event types (delivered, opened, clicked) are acknowledged but ignored.
    const actionable = ["email.bounced", "email.complained"];
    if (!actionable.includes(eventType)) {
      return jsonResponse(200, { ok: true, message: `Event '${eventType}' acknowledged, no action needed.` });
    }

    // Step 4: Look up which meeting this email was for using the Resend email ID.
    // The tracking record was stored when the invite was originally sent (meetings.mjs).
    if (!emailId) {
      log("warn", FN, "resend webhook missing email_id", { eventType });
      return jsonResponse(200, { ok: true, message: "No email_id in payload; cannot correlate." });
    }

    const emailTracker = getDb("email_records");
    const record = await emailTracker.get(emailId, { type: "json" }).catch(() => null);

    if (!record) {
      log("warn", FN, "no email record found for id", { emailId, eventType });
      return jsonResponse(200, { ok: true, message: "No record found for this email_id; no action taken." });
    }

    const { meeting_id, meeting_title, creator_email, creator_name, invitee_email } = record;

    // Step 5: Build and send a notification email to the meeting creator.
    const appUrl      = getEnv("APP_URL", "");
    const meetingUrl  = appUrl ? `${appUrl}/meeting.html?id=${encodeURIComponent(meeting_id)}` : null;
    const isComplaint = eventType === "email.complained";
    const bounceType  = body.data?.bounce?.type || "";
    const bounceMsg   = body.data?.bounce?.message || "";

    const subject = isComplaint
      ? `⚠️ Spam complaint from ${invitee_email} — MeetMe`
      : `⚠️ Invitation delivery failed for ${invitee_email} — MeetMe`;

    // escapeHtml() on user-supplied values prevents XSS in the notification.
    const escapedInvitee = escapeHtml(invitee_email);
    const escapedTitle   = escapeHtml(meeting_title);
    const reasonHtml = isComplaint
      ? `<p>The invitation email sent to <strong>${escapedInvitee}</strong> was marked as spam.</p>`
      : `<p>The invitation email sent to <strong>${escapedInvitee}</strong> could not be delivered (${escapeHtml(bounceType || "bounce")}${bounceMsg ? `: ${escapeHtml(bounceMsg)}` : ""}).</p>`;

    const html = `
      <p>Hello${creator_name ? ` ${escapeHtml(creator_name)}` : ""},</p>
      ${reasonHtml}
      <p><strong>Meeting:</strong> ${escapedTitle}</p>
      <p>This usually means the email address is invalid or the inbox doesn't exist.
         You may want to double-check the address and invite them again via the sharing link.</p>
      ${meetingUrl ? `<p><a href="${meetingUrl}">Open meeting</a></p>` : ""}
      <p style="color:#888;font-size:12px;">This is an automated notification from MeetMe.</p>
    `;
    const text = subject + `\n\nMeeting: ${meeting_title}\nInvitee: ${invitee_email}` +
      (meetingUrl ? `\n\nOpen meeting: ${meetingUrl}` : "");

    const notifyResult = await sendEmail({ to: creator_email, subject, html, text });

    if (!notifyResult.ok) {
      log("warn", FN, "failed to send bounce notification to creator", {
        creator: creator_email, error: notifyResult.error,
      });
    } else {
      log("info", FN, "bounce notification sent to creator", { creator: creator_email, invitee: invitee_email });
    }

    await persistEvent("warn", FN, "invite delivery issue", {
      eventType, invitee_email, creator_email, meeting_id, meeting_title,
    });

    return jsonResponse(200, { ok: true, message: "Handled." });
  }

  return errorResponse(404, "Not found.");
}

export const config = {
  path: "/api/webhooks/*",
};
