/**
 * email-preferences.mjs — Recipient email preference controls (no auth required)
 *
 * Routes handled:
 *   GET  /api/email-preferences/confirm?token=...&action=global_opt_out|block_organizer
 *   POST /api/email-preferences/apply
 */
import {
  verifyToken,
  validateEmail,
  saveEmailPreferences,
  log,
  persistEvent,
  escapeHtml,
} from "./utils.mjs";

const FN = "email-preferences";
const ACTIONS = new Set(["global_opt_out", "block_organizer"]);

function htmlResponse(status, html) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function parseAction(rawAction) {
  const action = String(rawAction || "").trim();
  return ACTIONS.has(action) ? action : "";
}

function parseTokenPayload(token) {
  const payload = verifyToken(String(token || ""));
  if (!payload || payload.purpose !== "email_preferences") return null;

  const email = validateEmail(payload.email || "");
  if (!email) return null;

  const organizerEmail = validateEmail(payload.organizer_email || "") || "";
  return {
    email,
    organizer_email: organizerEmail,
  };
}

function basePage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} - MeetMe</title>
    <link rel="stylesheet" href="/static/style.css" />
  </head>
  <body class="pref-page-body">
    <div class="pref-page-wrap">
      <main class="pref-page-card">${bodyHtml}</main>
    </div>
  </body>
</html>`;
}

function renderInvalidPage() {
  return basePage(
    "Invalid preference link",
    `
      <h1 class="err">This link is invalid or expired</h1>
      <p>Please use the latest email from MeetMe, or contact the organizer to send a new invitation.</p>
      <p class="muted">For security, preference links are signed and may expire.</p>
    `
  );
}

function renderConfirmPage({ action, email, organizerEmail }) {
  const actionTitle =
    action === "global_opt_out"
      ? "Stop all emails from MeetMe"
      : `Block meeting emails from ${organizerEmail}`;

  const actionDescription =
    action === "global_opt_out"
      ? "You will no longer receive emails from MeetMe at this address."
      : "You will stop receiving meeting emails from this organizer, but can still receive other MeetMe emails.";

  return basePage(
    "Confirm email preference",
    `
      <h1>${escapeHtml(actionTitle)}</h1>
      <p>${escapeHtml(actionDescription)}</p>
      <p class="pref-page-muted">Recipient: ${escapeHtml(email)}</p>
      <form method="POST" action="/api/email-preferences/apply">
        <input type="hidden" name="token" value="__TOKEN_PLACEHOLDER__" />
        <input type="hidden" name="action" value="${escapeHtml(action)}" />
        <div class="pref-page-actions">
          <button type="submit" class="btn btn-primary">Confirm</button>
          <a class="btn btn-ghost pref-page-link-button" href="/">Cancel</a>
        </div>
      </form>
    `
  );
}

async function parsePostBody(req) {
  const raw = await req.text().catch(() => "");
  const params = new URLSearchParams(raw);
  return {
    token: params.get("token") || "",
    action: params.get("action") || "",
  };
}

function renderAppliedPage({ action, email, organizerEmail }) {
  const message =
    action === "global_opt_out"
      ? "You will no longer receive MeetMe emails at this address."
      : `You will no longer receive meeting emails from ${organizerEmail}.`;

  return basePage(
    "Preference saved",
    `
      <h1 class="ok">Preference updated</h1>
      <p>${escapeHtml(message)}</p>
      <p class="pref-page-muted">Recipient: ${escapeHtml(email)}</p>
    `
  );
}

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  // GET /api/email-preferences/confirm
  if (req.method === "GET" && path === "/api/email-preferences/confirm") {
    const token = url.searchParams.get("token") || "";
    const action = parseAction(url.searchParams.get("action") || "");
    const payload = parseTokenPayload(token);

    if (!payload || !action) {
      return htmlResponse(400, renderInvalidPage());
    }

    if (action === "block_organizer" && !payload.organizer_email) {
      return htmlResponse(400, renderInvalidPage());
    }

    const html = renderConfirmPage({
      action,
      email: payload.email,
      organizerEmail: payload.organizer_email,
    }).replace("__TOKEN_PLACEHOLDER__", escapeHtml(token));

    return htmlResponse(200, html);
  }

  // POST /api/email-preferences/apply
  if (req.method === "POST" && path === "/api/email-preferences/apply") {
    const { token, action: rawAction } = await parsePostBody(req);
    const action = parseAction(rawAction);
    const payload = parseTokenPayload(token);

    if (!payload || !action) {
      return htmlResponse(400, renderInvalidPage());
    }

    const current = await saveEmailPreferences(payload.email, {});

    if (action === "global_opt_out") {
      await saveEmailPreferences(payload.email, {
        global_opt_out: true,
      });
      await persistEvent("info", FN, "recipient opted out globally", {
        recipient_email: payload.email,
      });
      log("info", FN, "global email opt-out applied", { recipient_email: payload.email });
    } else {
      const nextBlocked = [...new Set([...(current.blocked_organizers || []), payload.organizer_email])];
      await saveEmailPreferences(payload.email, {
        blocked_organizers: nextBlocked,
      });
      await persistEvent("info", FN, "recipient blocked organizer emails", {
        recipient_email: payload.email,
        organizer_email: payload.organizer_email,
      });
      log("info", FN, "organizer block applied", {
        recipient_email: payload.email,
        organizer_email: payload.organizer_email,
      });
    }

    return htmlResponse(
      200,
      renderAppliedPage({
        action,
        email: payload.email,
        organizerEmail: payload.organizer_email,
      })
    );
  }

  return new Response("Not found", { status: 404 });
}

export const config = {
  path: ["/api/email-preferences/confirm", "/api/email-preferences/apply"],
};
