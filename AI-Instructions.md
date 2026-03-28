# AI Instructions for MeetMe

Purpose: prevent repeated mistakes, especially around dependency management, lockfiles, platform-specific installs, and incomplete validation.

## 1. Core Working Rules

1. Treat `npm ci` success as a hard gate before claiming any dependency, lockfile, or CI fix is complete.
2. Never rely on a single signal (for example, lockfile text shape) when behavior can be validated by a command.
3. Prefer generated lockfile updates over manual lockfile surgery.
4. When a bug is lockfile/dependency related, validate in the current platform and Node/npm toolchain expected by CI.
5. Do not declare "fixed" unless final verification commands pass in the current checkout.

## 2. Required Validation Sequence

Run these in order after any dependency, lockfile, or CI change:

```bash
npm ci
npm test
npm audit --omit=dev
```

If any command fails, do not conclude the task. Keep iterating until it passes or document a verified blocker.

## 3. Dependency and Lockfile Rules

1. Do not hand-edit `package-lock.json` to flip one field unless there is no alternative and it is proven safe.
2. For Rollup platform-package issues (`EBADPLATFORM`), regenerate lockfile with compatible Linux + Node 20 toolchain and re-run `npm ci`.
3. If lockfile metadata seems suspicious (for example `extraneous` vs `optional` on platform packages), assume multiple related entries may need regeneration, not one-line patching.
4. Use lockfile regeneration commands instead of surgical edits:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
```

5. Commit lockfile changes only after successful `npm ci`.

## 4. Audit Rules

1. `npm audit fix` can loop on transitive, shrinkwrapped, or bundled dev dependencies.
2. If `npm audit fix` repeats the same message, inspect `npm audit --json` and identify whether remaining findings are dev-only.
3. For this repo, production gating should use:

```bash
npm audit --omit=dev
```

4. Do not claim all vulnerabilities are resolved if only dev-only upstream issues remain.

## 5. CI and Node Toolchain Consistency

1. Keep local troubleshooting aligned with CI Node version.
2. If CI pins a Node minor/patch, avoid testing majorly different local Node versions for lockfile-sensitive changes.
3. After touching workflows, confirm command parity between local and CI (especially install/test/audit commands).

## 6. Test Command and Shell Safety

1. Use shell-safe test patterns that work in non-interactive CI shells.
2. Prefer explicit globs that Node test runner resolves reliably in this repo.
3. Re-run tests after script changes; do not assume script edits are correct.

## 7. Git Hygiene for AI Changes

1. Never revert unrelated user changes.
2. Stage and commit only files that belong to the requested fix.
3. Keep commits focused (dependency fix, CI fix, or test-script fix should be clearly scoped).
4. Include a concise commit message that explains intent.

## 8. Communication Rules

1. Be explicit about what was validated versus inferred.
2. If a claim is based on observation, include the exact command that proved it.
3. If blocked, state the blocker and provide the best safe alternative.
4. If previous reasoning was wrong, acknowledge it directly and provide corrected action.

## 9. Definition of Done for Dependency/CI Tasks

A dependency/lockfile/CI task is done only when all are true:

1. `npm ci` passes.
2. `npm test` passes.
3. `npm audit --omit=dev` passes.
4. Relevant CI workflow command(s) match what was validated locally.
5. Changes are committed in a focused commit.

## 10. MeetMe-Specific Lessons Learned

1. Rollup platform package metadata in lockfiles can break installs on Linux/arm64.
2. A single suspicious lockfile line is usually part of a broader generated state issue.
3. `npm audit fix` output can be misleading when upstream dev dependencies are pinned.
4. Behavioral verification (`npm ci`) is the source of truth, not assumptions from lockfile text alone.
