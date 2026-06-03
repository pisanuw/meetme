# Changes

Format: `YYYY-MM-DD [type] description` (max 200 chars). Types: decision, plan, doc, scope, code, note.

2026-06-01 [plan] Start MeetMe build from empty repo following the staged implementation plan; fixed stack: Netlify static + Functions, Blobs, Resend, Google, vanilla JS.
2026-06-01 [code] Stage 1: static shell — index landing, style.css design system, shared nav/footer (layout.js), common.js helper stub; netlify.toml publish config.
2026-06-02 [code] Stage 2: serverless runtime — lib/http + lib/log helpers, utils.mjs barrel, auth.mjs health endpoint, /api/* function routing, custom 404 page + fallback redirect.
2026-06-03 [code] Stage 3: persistence — lib/db (Netlify Blobs JSON wrapper), lib/env (env validation), lib/utils-core (ids/time helpers), lib/user-store (user records keyed by normalized email).
2026-06-03 [code] Stage 4: sessions — lib/jwt (sign/verify JWT, getUserFromRequest from cookie or Bearer), auth.mjs me/profile/logout endpoints, HttpOnly token cookie. JWT_SECRET fails closed.
