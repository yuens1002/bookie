# /review report — remove presigned PUT, improve inline base64 docs

**Branch:** (uncommitted working tree, lighter cadence)
**Generated:** 2026-06-16
**De-facto owning roles:** `/backend-architect` (code + docs), `/test-engineer` (test)

## Verdict

Clear — all deliverables landed, tests cover every validation invariant, no live-doc drift. One minor finding: two stale plan docs describe the removed feature and should be deleted before committing.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| Remove `getSignedUploadUrl` from `blob.ts` | `src/domain/blob.ts:49-55` deleted | ✓ shipped |
| Remove presigned PUT import in `receipts.ts` | `src/tools/receipts.ts:8` | ✓ shipped |
| Update tool description to single-mode | `src/tools/receipts.ts:23-24` | ✓ shipped |
| Update `fileContent` / `mimeType` field descriptions | `src/tools/receipts.ts:49-60` | ✓ shipped |
| Restore `!fileContent && mimeType → fail()` guard | `src/tools/receipts.ts:81` | ✓ shipped |
| Revert bucket guard to `fileContent && !blobConfigured()` | `src/tools/receipts.ts:82-83` | ✓ shipped |
| Remove presigned PUT branch (35 lines) | `src/tools/receipts.ts:105-138` deleted | ✓ shipped |
| Remove `blobConfigured` import from test | `test/receipts.test.ts:2` deleted | ✓ shipped |
| Restore "fails when mimeType provided without fileContent" | `test/receipts.test.ts:147-156` | ✓ shipped |
| Remove presigned PUT describe block | `test/receipts.test.ts:398-472` deleted | ✓ shipped |
| Update `docs/DEPLOYING.md` — remove mobile upload section | lines 95-111 removed, bucket note updated | ✓ shipped |
| Update `docs/CHANGELOG.md` — replace presigned PUT Added entries | `[Unreleased]` section rewritten | ✓ shipped |
| Regenerate `docs/TOOLS.md` | `npm run docs:tools` — 16 tools | ✓ shipped |
| Version bump | `package.json` 0.7.1 → 0.7.2 | ✓ shipped |

### Code changes not tied to any deliverable
None.

## ACs ↔ Tests (spot-check — no formal ACs, lighter cadence)

| Check | Test | Asserts invariant? | Notes |
|-------|------|--------------------|-------|
| `fileContent` without `mimeType` → fail | `test/receipts.test.ts:136-145` | ✓ | Asserts `isError` + `/mimeType.*required/i`; fail message is `` "`mimeType` is required when `fileContent` is provided." `` — matches |
| `mimeType` without `fileContent` → fail | `test/receipts.test.ts:147-156` | ✓ | Asserts `isError` + `/fileContent.*required/i`; fail message is `` "`fileContent` is required when `mimeType` is provided." `` — matches |
| `fileContent` + bucket not configured → fail | `test/receipts.test.ts:158-185` | ✓ | Env var save/delete/restore in try/finally; asserts `/not configured/i` — matches fail message |
| All 201 tests pass | `npm test` | ✓ | Typecheck also clean |

## Docs drift

- `docs/ARCHITECTURE.md:79` — mentions "presigned GET URLs (1-hour TTL)" and "if bucket vars are absent, structured receipt data still saves; only `fileContent` upload is blocked." Both claims remain accurate after the removal. No change needed. ✓
- `README.md` — no presigned PUT references. ✓

## Minor finding: stale plan docs should be deleted

`docs/plans/receipt-presigned-upload-plan.md` and `docs/plans/receipt-presigned-upload-ACs.md` describe the presigned PUT feature that was implemented and then removed without ever being released. Both files:
- Reference code that no longer exists (`getSignedUploadUrl`)
- Contain ACs that are now false (e.g. "DEPLOYING.md has mobile upload section", "`mimeType` only returns upload URL")
- The feature never shipped in a version tag — there is no historical value in keeping them

**Action before commit:** delete both files.

## Recommendations

1. Delete `docs/plans/receipt-presigned-upload-plan.md` and `docs/plans/receipt-presigned-upload-ACs.md` — stale docs for a feature that was never released. Leaving them risks a future reader confusing the plan as describing live behavior.
2. (No other issues — proceed to `/commit`.)

## Inputs for /retro

No new process lessons from this change — it was a straightforward removal with all the right checks applied. The mandatory `/review` gate (gate 37) is what surfaced the stale plan doc finding, confirming the gate is working.
