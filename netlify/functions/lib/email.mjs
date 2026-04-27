/**
 * lib/email.mjs — Email delivery via Resend, and recipient preference management
 *
 * All outbound email flows through sendEmail so that:
 *   • API key and sender address are read from one place
 *   • Error handling is consistent across features (invites, reminders, feedback)
 *   • Swapping email providers only requires changing this one function
 */
import { getDb } from "./db.mjs";
import { getEnv } from "./env.mjs";
import { escapeHtml } from "./utils-core.mjs";

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function emailPreferenceKey(email) {
  return `email:${normalizeEmail(email)}`;
}

/**
 * Load persisted email preferences for a recipient.
 *
 * @param {string} recipientEmail
 * @returns {Promise<{ email: string, global_opt_out: boolean, blocked_organizers: string[], updated_at: string|null }>}
 */
export async function getEmailPreferences(recipientEmail) {
  const email = normalizeEmail(recipientEmail);
  const base = {
    email,
    global_opt_out: false,
    blocked_organizers: [],
    updated_at: null,
  };

  if (!email) return base;

  const prefsDb = getDb("email_preferences");
  const raw = await prefsDb.get(emailPreferenceKey(email), { type: "json" }).catch(() => null);
  if (!raw || typeof raw !== "object") return base;

  const blocked = (Array.isArray(raw.blocked_organizers) ? raw.blocked_organizers : [])
    .map((item) => normalizeEmail(item))
    .filter(Boolean);

  return {
    email,
    global_opt_out: raw.global_opt_out === true,
    blocked_organizers: [...new Set(blocked)],
    updated_at: raw.updated_at || null,
  };
}

/**
 * Persist recipient email preferences.
 *
 * @param {string} recipientEmail
 * @param {{ global_opt_out?: boolean, blocked_organizers?: string[] }} updates
 * @returns {Promise<{ email: string, global_opt_out: boolean, blocked_organizers: string[], updated_at: string }>}
 */
export async function saveEmailPreferences(recipientEmail, updates = {}) {
  const current = await getEmailPreferences(recipientEmail);
  const blocked = Array.isArray(updates.blocked_organizers)
    ? updates.blocked_organizers
    : current.blocked_organizers;

  const next = {
    email: current.email,
    global_opt_out:
      typeof updates.global_opt_out === "boolean" ? updates.global_opt_out : current.global_opt_out,
    blocked_organizers: [
      ...new Set(
        (Array.isArray(blocked) ? blocked : [])
          .map((item) => normalizeEmail(item))
          .filter(Boolean)
      ),
    ],
    updated_at: new Date().toISOString(),
  };

  if (!next.email) return next;

  const prefsDb = getDb("email_preferences");
  await prefsDb.setJSON(emailPreferenceKey(next.email), next);
  return next;
}

/**
 * Determine whether email delivery should be suppressed for a recipient.
 *
 * @param {object} opts
 * @param {string} opts.recipientEmail
 * @param {"general"|"meeting"} [opts.category]
 * @param {string} [opts.organizerEmail]
 * @returns {Promise<{ suppress: boolean, reason: string|null }>}
 */
export async function shouldSuppressEmailDelivery({
  recipientEmail,
  category = "general",
  organizerEmail = "",
} = {}) {
  const recipient = normalizeEmail(recipientEmail);
  if (!recipient) return { suppress: false, reason: null };

  const prefs = await getEmailPreferences(recipient);
  if (prefs.global_opt_out) {
    return { suppress: true, reason: "global_opt_out" };
  }

  const organizer = normalizeEmail(organizerEmail);
  if (category === "meeting" && organizer && prefs.blocked_organizers.includes(organizer)) {
    return { suppress: true, reason: "organizer_blocked" };
  }

  return { suppress: false, reason: null };
}

/**
 * Send an email via the Resend API.
 *
 * Requires environment variables:
 *   RESEND_API_KEY    — API key from resend.com
 *   AUTH_FROM_EMAIL   — Verified sender address, e.g. "MeetMe <noreply@example.com>"
 *
 * @param {object} opts
 * @param {string|string[]} opts.to      - Recipient address(es)
 * @param {string}          opts.subject
 * @param {string}          opts.html    - HTML body
 * @param {string}          opts.text    - Plain-text fallback
 * @param {string}          [opts.replyTo] - Reply-To address
 * @param {Array<{name:string,value:string}>} [opts.tags] - Resend tags for analytics
 * @param {{ category?: "general"|"meeting", organizerEmail?: string }} [opts.suppression]
 * @returns {Promise<{ ok: boolean, emailId?: string, error?: string }>}
 */
export async function sendEmail({ to, subject, html, text, replyTo, tags, suppression } = {}) {
  const apiKey = getEnv("RESEND_API_KEY");
  const fromEmail = getEnv("AUTH_FROM_EMAIL");
  if (!apiKey || !fromEmail) {
    return {
      ok: false,
      error: "Email delivery is not configured (RESEND_API_KEY / AUTH_FROM_EMAIL missing).",
    };
  }
  try {
    const siteUrl =
      getEnv("APP_URL", "").trim() ||
      getEnv("URL", "").trim() ||
      getEnv("DEPLOY_PRIME_URL", "").trim();
    const normalizedSiteUrl = siteUrl.replace(/\/+$/, "");
    const htmlFooter = normalizedSiteUrl
      ? `\n<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;" /><p style="margin:0;color:#6b7280;font-size:12px;">MeetMe: <a href="${escapeHtml(normalizedSiteUrl)}" style="color:#1976d2;">${escapeHtml(normalizedSiteUrl)}</a></p>`
      : "";
    const textFooter = normalizedSiteUrl ? `\n\n---\nMeetMe: ${normalizedSiteUrl}` : "";

    const htmlWithFooter = `${String(html || "")}${htmlFooter}`;
    const textWithFooter = `${String(text || "")}${textFooter}`;

    const recipients = (Array.isArray(to) ? to : [to])
      .map((item) => normalizeEmail(item))
      .filter(Boolean);

    const suppressedRecipients = [];
    const deliverableRecipients = [];

    for (const recipient of recipients) {
      const suppressionResult = await shouldSuppressEmailDelivery({
        recipientEmail: recipient,
        category: suppression?.category || "general",
        organizerEmail: suppression?.organizerEmail || "",
      });
      if (suppressionResult.suppress) {
        suppressedRecipients.push({ email: recipient, reason: suppressionResult.reason });
      } else {
        deliverableRecipients.push(recipient);
      }
    }

    if (deliverableRecipients.length === 0) {
      return {
        ok: false,
        error: "Email suppressed by recipient preference.",
        suppressed_recipients: suppressedRecipients,
      };
    }

    const payload = {
      from: fromEmail,
      to: deliverableRecipients,
      subject,
      html: htmlWithFooter,
      text: textWithFooter,
    };
    if (replyTo) payload.reply_to = replyTo;
    if (tags && tags.length) payload.tags = tags;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Resend API error (HTTP ${res.status}): ${body.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, emailId: data.id, suppressed_recipients: suppressedRecipients };
  } catch (err) {
    return { ok: false, error: `Email send failed: ${err.message}` };
  }
}
