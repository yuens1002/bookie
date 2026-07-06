# /review report — manage_receipts mobile upload description clarity

**Branch:** `main` (uncommitted, pre-PR)
**Generated:** 2026-07-05
**Iterations to reach verified:** 1

## Structural exception (no in-repo plan)

Lighter cadence, no plan doc — a docs/description-only clarification requested directly, following a live investigation into whether mobile receipt upload actually works. De-facto owning role: `/backend-architect` (project-local) — owns tool `.describe()` text per its gate 4 (tool design) and gate 7 (docs follow code).

## Verdict

**Clear.** No logic changed — only `.describe()` text on `manage_receipts`'s top-level description and its `fileContent` field, plus a regenerated `docs/TOOLS.md`. Full test suite unaffected (description strings aren't asserted by any test); `test/receipts.test.ts` reruns 17/17 green as a sanity check.

## What shipped

Context: a live investigation (this session) confirmed the Railway Bucket upload path works correctly end-to-end when a client can actually supply `fileContent` — verified by attaching a real file to a real entry, fetching the resulting signed URL (200, correct bytes), then cleaning up. Cross-referencing git history found that a presigned-PUT upload workaround for mobile (PR #27) was built and removed one day later (PR #28) because Claude.ai's sandboxed runtime blocks outbound HTTP to signed URLs — so no upload path has ever been possible from Claude.ai mobile/web, by two independent, already-explored routes (inline base64, presigned PUT).

`src/tools/receipts.ts`: rewrote the tool's top-level `description` and the `fileContent` field's `.describe()` to state this as a hard directive rather than a soft aside — "never pass `fileContent`" from Claude.ai clients, with the reason (no raw byte access; the presigned-PUT alternative was tried and abandoned) inlined so a future agent session doesn't rediscover or re-attempt it. Also states explicitly that `hasFile:false` from a structured-only attach is the complete, correct outcome — not a fallback state to explain away.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| Explicit mobile-upload guidance in tool description | `src/tools/receipts.ts:24-27` | ✓ shipped |
| Matching guidance on `fileContent` field | `src/tools/receipts.ts:52-56` | ✓ shipped |
| Regenerate `docs/TOOLS.md` | `npm run docs:tools` (16 tools) | ✓ shipped |
| Changelog entry | `CHANGELOG.md` → `[Unreleased] → Changed` | ✓ shipped |

### Code changes not tied to any deliverable
`docs/TOOLS.md` also picked up pre-existing, unrelated drift from PR #30 (`add_transaction`/`import_transactions` describe clarifications that were committed without a `docs:tools` regen at the time) — included here since regenerating necessarily catches all current drift, not just this change's. Noted in the CHANGELOG entry so it isn't silently bundled.

## Docs drift

`README.md`'s `manage_receipts` summary row remains accurate as a high-level one-liner and doesn't carry mobile-specific nuance by design (`docs/TOOLS.md` is the generated/detailed reference; README is the human-facing summary, per existing convention) — no change needed there.

## Recommendations

None outstanding.

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"When a tool's `.describe()` text needs to steer a specific client class away from a code path that looks plausible but is guaranteed to fail (not just suboptimal), state it as a directive ('never do X') with the reason inlined, not a soft aside ('in that workflow, do Y'). A future agent session reads only the tool description at call time, not this repo's git history — if a workaround was already tried and proven impossible (e.g. this repo's removed presigned-PUT path, blocked by Claude.ai's sandboxed runtime), say so in the description itself so it isn't silently rediscovered and re-attempted."*
  **Triggered by:** this change — the original mobile guidance was accurate but phrased as a suggestion ("in that workflow, call attach with structured fields only"), not a hard prohibition, and carried no memory of the already-abandoned presigned-PUT alternative.

## Ready for Review

- /review report: `docs/plans/mobile-receipt-upload-docs-clarity-review.md`

One paragraph: `manage_receipts`'s tool description now explicitly directs Claude.ai (mobile/web) clients to never pass `fileContent`, states why (no raw byte access, and a signed-URL upload alternative was already tried and removed because the sandboxed runtime blocks outbound HTTP), and frames `hasFile:false` from a structured-only attach as the correct, complete outcome rather than a fallback. Pure `.describe()` text change plus a `docs/TOOLS.md` regen; no logic touched, full suite green. Clear to proceed to `/commit`.
