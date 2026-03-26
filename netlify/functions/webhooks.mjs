import { getDb, getEnv, safeJson, log, persistEvent, sendEmail } from "./utils.mjs";

const FN = "webhooks";

export default async (req, context) => {
  try {
    return await handleWebhook(req, context);
  } catch (err) {
    log("error", FN, "unhandled exception", { message: err.message, stack: err.stack });
    return new Response(JSON.stringify({ error: "Internal server error." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

function ok(msg = "ok") {
  return new Response(JSON.stringify({ ok: true, message: msg }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function reject(msg, status = 403) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleWebhook(req, context) {
  const url = new URL(req.url);
  const path = context.params["0"] || "";

  // ─── POST /api/webhooks/resend ───────────────────────────────────────────
  if (req.method === "POST" && path === "resend") {
    // Verify shared secret passed in the Resend webhook URL
    const expectedSecret = getEnv("RESEND_WEBHOOK_SECRET", "");
    const providedSecret  = url.searchParams.get("secret") || "";

    if (!expectedSecret) {
      log("warn", FN, "RESEND_WEBHOOK_SECRET is not set — webhook rejected");
      return reject("Webhook secret not configured on server.", 500);
    }
    if (!providedSecret || providedSecret !== expectedSecret) {
      log("warn", FN, "resend webhook secret mismatch");
      return reject("Invalid webhook secret.");
    }

    const body = await safeJson(req);
    if (!body) {
      log("warn", FN, "resend webhook body is not valid JSON");
      return reject("Invalid JSON body.", 400);
    }

    const eventType = body.type || "";
    const emailId   = body.data?.email_id || body.data?.id || "";
    const toList    = body.data?.to || [];
    const toEmail   = Array.isArray(toList) ? toList[0] : toList;

    log("info", FN, "resend webhook received", { eventType, emailId, to: toEmail });
    await persistEvent("info", FN, "resend webhook", { eventType, emailId, to: toEmail });

    // Only act on hard bounces and spam complaints
    const actionable = ["email.bounced", "email.complained"];
    if (!actionable.includes(eventType)) {
      return ok(`Event '${eventType}' acknowledged, no action needed.`);
    }

    // Look up what meeting this email was for
    if (!emailId) {
      log("warn", FN, "resend webhook missing email_id", { eventType });
      return ok("No email_id in payload; cannot correlate.");
    }

    const emailTracker = getDb("email_records");
    const record = await emailTracker.get(emailId, { type: "json" }).catch(() => null);

    if (!record) {
      log("warn", FN, "no email record found for id", { emailId, eventType });
      return ok("No record found for this email_id; no action taken.");
    }

    const { meeting_id, meeting_title, creator_email, creator_name, invitee_email } = record;

    // Build the notification email to the creator
    const appUrl      = getEnv("APP_URL", "");
    const meetingUrl  = appUrl ? `${appUrl}/meeting.html?id=${encodeURIComponent(meeting_id)}` : null;
    const isComplaint = eventType === "email.complained";
    const bounceType  = body.data?.bounce?.type || "";
    const bounceMsg   = body.data?.bounce?.message || "";

    const subject = isComplaint
      ? `⚠️ Spam complaint from ${invitee_email} — MeetMe`
      : `⚠️ Invitation delivery failed for ${invitee_email} — MeetMe`;

    const reasonHtml = isComplaint
      ? `<p>The invitation email sent to <strong>${invitee_email}</strong> was marked as spam.</p>`
      : `<p>The invitation email sent to <strong>${invitee_email}</strong> could not be delivered (${bounceType || "bounce"}${bounceMsg ? `: ${bounceMsg}` : ""}).</p>`;

    const html = `
      <p>Hello${creator_name ? ` ${creator_name}` : ""},</p>
      ${reasonHtml}
      <p><strong>Meeting:</strong> ${meeting_title}</p>
      <p>This usually means the email address is invalid or the inbox doesn't exist.
         You may want to double-check the address and invite them again via the sharing link.</p>
      ${meetingUrl ? `<p><a href="${meetingUrl}">Open meeting</a></p>` : ""}
      <p style="color:#888;font-size:12px;">This is an automated notification from MeetMe.</p>
    `;
    const text = subject + `\n\nMeeting: ${meeting_title}\nInvitee: ${invitee_email}` +
      (meetingUrl ? `\n\nOpen meeting: ${meetingUrl}` : "");

    const notifyResult = await sendEmail({
      to: creator_email,
      subject,
      html,
      text,
    });

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

    return ok("Handled.");
  }

  return new Response(JSON.stringify({ error: "Not found." }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

export const config = {
  path: "/api/webhooks/*",
};
