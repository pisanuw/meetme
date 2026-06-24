#!/usr/bin/env node
/**
 * typecheck.mjs — run `tsc --checkJs` over the JSDoc-typed Node code and gate
 * on a shrinking baseline.
 *
 * Why a baseline: the Netlify Functions code is JSDoc-typed but its serverless
 * edges (Blobs store shapes, request context, discriminated-union validators
 * under non-strict null checks) produce a known set of edge-typing findings
 * that are not runtime bugs. Rather than suppress them inline or rewrite the
 * control flow under time pressure (risking a regression), we record the exact
 * set in `types/typecheck-baseline.txt`. This script:
 *
 *   - runs `tsc -p jsconfig.json`,
 *   - ignores any error inside `node_modules/` (third-party),
 *   - normalizes each remaining error to a stable signature (path + TS code +
 *     message, dropping line:col so unrelated edits don't churn the baseline),
 *   - FAILS if any signature is NOT in the baseline (a genuinely new type
 *     error), and also fails if the baseline lists a signature that no longer
 *     occurs (so the baseline can only shrink — stale entries must be removed).
 *
 * Exit code is 0 only when current errors == baseline exactly. New errors block
 * CI; fixed errors force the baseline to be trimmed. The count can only go down.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, "types", "typecheck-baseline.txt");

function normalize(line) {
  // "path/file.mjs(12,34): error TS2339: msg"  ->  "path/file.mjs: error TS2339: msg"
  return line.replace(/^(.+?)\(\d+,\d+\): (error TS\d+:.*)$/, "$1: $2").trim();
}

const tsc = spawnSync("npx", ["--no-install", "tsc", "-p", join(repoRoot, "jsconfig.json")], {
  cwd: repoRoot,
  encoding: "utf8",
});

if (tsc.error) {
  console.error("Failed to run tsc:", tsc.error.message);
  process.exit(2);
}

const output = `${tsc.stdout || ""}${tsc.stderr || ""}`;
const current = output
  .split("\n")
  .filter((l) => /error TS\d+:/.test(l))
  .filter((l) => !l.includes("node_modules/"))
  .map(normalize)
  .filter(Boolean)
  .sort();

const baseline = existsSync(baselinePath)
  ? readFileSync(baselinePath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .sort()
  : [];

// Multiset diff.
function multisetSubtract(a, b) {
  const counts = new Map();
  for (const x of b) counts.set(x, (counts.get(x) || 0) + 1);
  const out = [];
  for (const x of a) {
    const c = counts.get(x) || 0;
    if (c > 0) counts.set(x, c - 1);
    else out.push(x);
  }
  return out;
}

const newErrors = multisetSubtract(current, baseline); // in current, not covered by baseline
const fixedErrors = multisetSubtract(baseline, current); // in baseline, no longer present

if (newErrors.length === 0 && fixedErrors.length === 0) {
  console.log(`typecheck OK — ${current.length} known baseline finding(s), 0 new.`);
  process.exit(0);
}

if (newErrors.length > 0) {
  console.error(`\n✖ ${newErrors.length} NEW type error(s) not in the baseline:`);
  for (const e of newErrors) console.error(`  ${e}`);
}
if (fixedErrors.length > 0) {
  console.error(
    `\n✔ ${fixedErrors.length} baseline finding(s) no longer occur — trim them from types/typecheck-baseline.txt so the baseline keeps shrinking:`
  );
  for (const e of fixedErrors) console.error(`  ${e}`);
}
process.exit(1);
