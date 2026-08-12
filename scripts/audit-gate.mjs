#!/usr/bin/env node
/**
 * audit-gate.mjs — production dependency audit with a narrow, documented
 * advisory allowlist.
 *
 * Why not plain `npm audit --omit=dev`: our only runtime dependency that
 * carries advisories is `@netlify/blobs`. We are pinned to 10.1.0 on purpose:
 *
 *   - 10.0.0 is the FIRST version with the conditional-write API
 *     (`setJSON(key, val, { onlyIfMatch | onlyIfNew }) -> { modified }`) that
 *     `updateJsonWithCas` in netlify/functions/lib/db.mjs depends on for
 *     compare-and-swap writes. 9.x returns `Promise<void>` and has no such
 *     option — downgrading (npm's `--force` suggestion) would silently break
 *     CAS and reintroduce the "rate-limited&retry=1" prod bug (see CHANGES,
 *     2026-06-29).
 *   - 10.2.0+ adds `@netlify/otel`, which pulls a vulnerable
 *     `@opentelemetry/core` (GHSA-8988-4f7v-96qf). So 10.1.0 is the optimal pin.
 *
 * The remaining advisories come from `@netlify/blobs` -> `@netlify/dev-utils`
 * -> `image-size` (DoS via infinite loops in the ICNS/JXL/HEIF parsers).
 * `image-size` has NO patched release (the advisory covers all versions, and
 * dev-utils requires `image-size@^2.0.2`), so there is no version bump or
 * `overrides` that clears it. Critically, the `image-size` import in dev-utils
 * lives in its local dev image-server / test helpers (`createImageServerHandler`,
 * `generateImage`, `getImageResponseSize`) — code that only runs under
 * `netlify dev`, never in the deployed Functions request path, which only calls
 * blob get/set. So it is not reachable in production.
 *
 * This gate therefore ALLOWLISTS exactly those two image-size advisories by
 * their GHSA id and FAILS on any other advisory (any package, any severity).
 * The gate is not a blanket relaxation: a new prod vuln, or a new advisory on
 * a different package, still turns CI red. Remove entries below once
 * @netlify/dev-utils drops image-size or image-size ships a patched release.
 */
import { spawnSync } from "node:child_process";

/** GHSA id -> reason. Every entry must be justified as not-production-reachable. */
const ALLOWLIST = new Map([
  [
    "GHSA-w3rx-r6r6-pgpr",
    "image-size ICNS parser DoS — transitive via @netlify/blobs -> @netlify/dev-utils; dev-server/test-only code, no patched release. Remove when upstream fixes.",
  ],
  ["GHSA-5p2g-fcmc-qvqq", "image-size JXL/HEIF parser DoS — same chain and rationale as above."],
]);

// Lowercased view for case-insensitive lookup (allowlist keeps canonical casing).
const allowById = new Map([...ALLOWLIST].map(([k, v]) => [k.toLowerCase(), v]));

const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
});

if (audit.error) {
  console.error("Failed to run npm audit:", audit.error.message);
  process.exit(2);
}

// `npm audit` exits non-zero when advisories exist; the JSON is still on stdout.
const raw = audit.stdout || "";
let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error("Could not parse `npm audit --json` output. Raw stderr:");
  console.error(audit.stderr || "(none)");
  console.error("Raw stdout:");
  console.error(raw.slice(0, 2000) || "(empty)");
  process.exit(2);
}

/**
 * Collect every distinct advisory (npm audit v2 format nests them in each
 * vulnerability's `via` array; string entries are transitive references to
 * other vulnerable packages, not independent advisories, so we skip them).
 */
const GHSA_RE = /GHSA-[0-9a-z-]+/i;
const advisories = new Map(); // ghsaId -> { title, severity, url, pkg }
for (const [pkg, v] of Object.entries(report.vulnerabilities || {})) {
  for (const via of v.via || []) {
    if (typeof via !== "object" || !via.url) continue;
    const match = GHSA_RE.exec(via.url);
    if (!match) continue;
    // GHSA ids are lowercase in advisory URLs; normalize so allowlist lookups
    // are case-insensitive regardless of how npm reports them.
    const id = match[0].toLowerCase();
    if (!advisories.has(id)) {
      advisories.set(id, {
        title: via.title || "(no title)",
        severity: via.severity || v.severity || "unknown",
        url: via.url,
        pkg: via.name || pkg,
      });
    }
  }
}

const disallowed = [...advisories.entries()].filter(([id]) => !allowById.has(id));
const allowedSeen = [...advisories.keys()].filter((id) => allowById.has(id));

if (allowedSeen.length > 0) {
  console.log(`Allowlisted advisories (not production-reachable), ignored:`);
  for (const id of allowedSeen) {
    const a = advisories.get(id);
    console.log(`  - ${id} [${a.severity}] ${a.pkg}: ${a.title}`);
    console.log(`      reason: ${allowById.get(id)}`);
  }
}

if (disallowed.length === 0) {
  console.log(`\n✔ Production audit clean (${allowedSeen.length} allowlisted, 0 unexpected).`);
  process.exit(0);
}

console.error(`\n✖ ${disallowed.length} advisory(ies) NOT in the allowlist:`);
for (const [id, a] of disallowed) {
  console.error(`  - ${id} [${a.severity}] ${a.pkg}: ${a.title}`);
  console.error(`      ${a.url}`);
}
console.error(
  `\nReview each: fix (bump/override), or, only if genuinely not production-reachable, add its GHSA id to the ALLOWLIST in scripts/audit-gate.mjs with a justification.`
);
process.exit(1);
