# Changes

Format: `YYYY-MM-DD [type] description` (max 200 chars). Types: decision, plan, doc, scope, code, note.

2026-06-01 [plan] Start MeetMe build from empty repo following the staged implementation plan; fixed stack: Netlify static + Functions, Blobs, Resend, Google, vanilla JS.
2026-06-01 [code] Stage 1: static shell — index landing, style.css design system, shared nav/footer (layout.js), common.js helper stub; netlify.toml publish config.
2026-06-02 [code] Stage 2: serverless runtime — lib/http + lib/log helpers, utils.mjs barrel, auth.mjs health endpoint, /api/* function routing, custom 404 page + fallback redirect.
2026-06-03 [code] Stage 3: persistence — lib/db (Netlify Blobs JSON wrapper), lib/env (env validation), lib/utils-core (ids/time helpers), lib/user-store (user records keyed by normalized email).
2026-06-03 [code] Stage 4: sessions — lib/jwt (sign/verify JWT, getUserFromRequest from cookie or Bearer), auth.mjs me/profile/logout endpoints, HttpOnly token cookie. JWT_SECRET fails closed.
2026-06-04 [code] Stage 5: email — lib/email single sendEmail() choke-point over the Resend API, escapeHtml for user content, type tags, dev logging; suppression-aware preference helpers.
2026-06-05 [code] Stage 6: passwordless login — magic-link.mjs request/verify (16-char single-use token, 15-min TTL), auth-helpers getOrCreateUser; auth.mjs delegates magic-link/* routes.
2026-06-06 [code] Stage 7: auth UI + client helpers — login/register/email-sent pages; common.js apiFetch/checkAuth/requireAuth/showFlash/escapeHtml and the account nav dropdown.
2026-06-07 [code] Stage 8: profile — profile.html/js with name + timezone auto-detect, profile-complete setup hint and skip-for-now, backed by auth.mjs GET/POST profile.
