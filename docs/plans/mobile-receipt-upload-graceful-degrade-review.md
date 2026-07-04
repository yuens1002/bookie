# /review report — mobile receipt upload graceful degrade

**Branch:** `claude/mobile-image-upload-bug-797yfg`
**Generated:** 2026-07-04
**Iterations to reach verified:** 1

## Structural exception (no in-repo plan)

Lighter cadence, no plan doc — a bug fix pushed directly from a separate Claude Code remote/mobile session (commit `1a89ebf`, `Co-Authored-By: Claude Sonnet 4.6`, session `https://claude.ai/code/session_01KpvwTEuX3a5fHim6F28Uea`), reviewed here before opening a PR. De-facto owning roles:

- `/backend-architect` (project-local) — owns `src/tools/receipts.ts`'s behavior.
- `/test-engineer` (project-local) — owns `test/receipts.test.ts`.

## Verdict

**Clear, after fixing one real gap.** The behavioral fix itself is correct and well-motivated — confirmed against a same-day Open Brain observation (captured 2026-07-04, referenced as "OB1" in the original commit message) that verified this exact expected behavior end-to-end in a live session. But the fix shipped without updating the one existing test that directly asserted the *old* (now-wrong) behavior — the full suite was red on this branch (`npx vitest run test/receipts.test.ts` → 1 failed) until fixed here.

## What shipped (original commit, `1a89ebf`)

`src/tools/receipts.ts`: when `manage_receipts action='attach'` is called with `fileContent` but Railway Bucket env vars aren't configured, the tool previously returned a hard `fail()`. Now it sets `skipFileUpload = true`, skips the upload, still saves the structured receipt data (merchant/date/total/lineItems), and returns `hasFile: false` + a `fileWarning` explaining what happened — matching the tool's own pre-existing doc description ("structured data is always stored — no bucket required").

## Findings

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | `test/receipts.test.ts:158` ("fails when fileContent is provided but bucket is not configured") asserted the *old* hard-fail behavior (`isError: true`, message matches `/not configured/i`) — directly contradicted by this fix's new graceful-degrade behavior. Confirmed live: `npx vitest run test/receipts.test.ts` on this branch, unmodified, failed with `expected undefined to be true` (i.e. `res.isError` was `undefined`, not `true`, because the call now succeeds). | Severe (red test suite) | Fixed — rewrote the test to assert the new invariant: `hasFile: false`, `mimeType: null`, `fileWarning` matches `/not configured/i`, structured data (`merchant`) is actually persisted (queried `prisma.receipt.findUnique` directly, not just the tool response — the invariant that matters is "data survived," not just "response looks right"), and `fileKey` is `null` in the stored row. Renamed the test to describe what it now verifies. Re-ran: 17/17 pass. |

## Verification

- `npx vitest run test/receipts.test.ts` — 17/17 pass (was 16/17 before the fix).
- `npm run typecheck` — clean.
- Full suite (`npx vitest run`) — 15 files / 237 tests, all pass on rerun. (One earlier run showed 2 unrelated failures in `test/resources-prompts.test.ts` — a transient flake, not reproducible on rerun and unrelated to files touched by this change; not investigated further here.)
- Cross-checked against Open Brain thought `050986d8-0655-404b-95c4-97c04174cef8` (captured same day, 2026-07-04) — an end-to-end mobile session that verified `hasFile:false` is the *correct*, expected outcome when a mobile client's `manage_receipts` call can't attach a file, not a bug to mask. This fix makes the code match that already-validated expectation.

## Docs drift

None. `docs/TOOLS.md` only documents input schemas (auto-generated from Zod `.describe()`), not response shapes — the tool's `inputSchema` is unchanged, so no `docs:tools` regen is needed. The tool's own input description already promised "structured data is always stored — no bucket required"; this fix makes runtime behavior match that promise instead of contradicting it.

## Recommendations

None outstanding.

## Inputs for /retro

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"When reviewing a bug fix that changes a tool's error-vs-success branch (a case that used to `fail()` now returns `ok()`, or vice versa), always re-run the full test file for that tool before treating the fix as done — a test asserting the old behavior will silently rot into a red suite. This applies whether the fix originates locally or arrives pre-written from another session/branch; a remote-authored commit doesn't get a pass on this check just because it already has a plausible-looking diff."*
  **Triggered by:** this review — the original fix (from a separate Claude Code remote session) was behaviorally correct but shipped with the suite red, because the one test exercising this exact branch asserted the old contract.

## Ready for Review

- /review report: `docs/plans/mobile-receipt-upload-graceful-degrade-review.md`

One paragraph: a fix originating from a separate Claude Code mobile/remote session (`src/tools/receipts.ts`) makes `manage_receipts` gracefully degrade — save structured data and return `hasFile:false` + a warning — instead of hard-failing when a mobile client sends `fileContent` but Railway Bucket isn't configured. Cross-checked against a same-day Open Brain observation confirming this is the *correct* expected behavior, not a bug being masked. One real gap found: the existing test for this exact branch asserted the old hard-fail contract and left the suite red; rewrote it to assert the new invariant (including that structured data is actually persisted, not just that the response looks right) and confirmed 17/17 pass. Clear to proceed to `/commit`.
