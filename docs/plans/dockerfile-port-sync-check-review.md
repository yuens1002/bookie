# /review report — Dockerfile PORT/EXPOSE sync check

**Branch:** `main` (uncommitted, pre-PR)
**Generated:** 2026-07-03
**Iterations to reach verified:** 1

## Structural exception (no in-repo plan)

This change is on bookie's lighter cadence (`CLAUDE.md`: "skip the full `/agentic-workflow` ceremony" for this repo) — no `feature-plan.md` / `ACs.md` exists; it's a single follow-up regression test requested directly, not a feature. De-facto owning role for `/retro` routing:

- `/test-engineer` (project-local, `.claude/commands/test-engineer.md`) — owns `test/dockerfile.test.ts`.

Steps 1–2 (deliverables↔code, AC↔test mapping) are abbreviated accordingly — reviewed as a single-file diff against its stated purpose (guard the regression from `docs/plans/verify-npm-install-review.md` Finding #11 / CHANGELOG v0.8.2) rather than a deliverables list.

## Verdict

**Clear.** One file added (`test/dockerfile.test.ts`), one `CHANGELOG.md` entry. No findings.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| Guard against `ENV PORT` / `EXPOSE` drift in `Dockerfile` | `test/dockerfile.test.ts:14-20` | ✓ shipped |
| Changelog entry for the new guard | `CHANGELOG.md` — `[Unreleased] → Added` | ✓ shipped |

### Code changes not tied to any deliverable
None.

## ACs ↔ Tests (Gate 3 spot-check)

No ACs doc exists; spot-checked the test directly against its stated purpose instead.

| Check | Result |
|-------|--------|
| Asserts the real invariant (not vacuous) | ✓ — reads the actual `Dockerfile` via `readFileSync`, extracts both values via regex, compares them at runtime; doesn't hardcode either side. |
| Actually catches the regression it targets | ✓ — verified live: temporarily changed `Dockerfile`'s `ENV PORT` to `3000` (leaving `EXPOSE 8080`), reran the test, got a clean failure (`expected '8080' to be '3000'`); reverted via `git checkout`. |
| No DB/network dependency (fast, always-on in `npm test`) | ✓ — plain file read; `test/setup.ts` only loads `dotenv/config`, no DB call gates this file. |
| Follows test-engineer conventions | ✓ — co-located under `test/`, Vitest, isolated (no shared state), no formatting-string assertions. |

## Docs drift

None. `docs/DEPLOYING.md`'s existing troubleshooting note about the 502/target-port mismatch (added in PR #42) still accurately describes the failure mode this test now guards against — no update needed since the test doesn't change runtime behavior or documented env vars.

## Recommendations

None outstanding.

## Inputs for /retro

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"When a live incident is root-caused to two config values that must stay in sync but live in the same static file (e.g. a Dockerfile's `ENV PORT` and `EXPOSE`, or similar paired declarations), add a plain file-read unit test asserting they match — no DB/network fixture needed. This is cheaper than a full deploy-and-curl e2e and catches the actual regression (someone edits one value without the other) at `npm test` time instead of waiting for the next live deploy to surface it again."*
  **Triggered by:** the Railway 502 incident (`docs/plans/verify-npm-install-review.md` Finding #11, CHANGELOG v0.8.2) — root cause was exactly this kind of paired-value drift, and it had no regression guard until now.

## Ready for Review

- /review report: `docs/plans/dockerfile-port-sync-check-review.md`

One paragraph: a single new test (`test/dockerfile.test.ts`) asserts the Dockerfile's `ENV PORT` and `EXPOSE` values match, guarding the exact target-port mismatch that caused the v0.8.2 Railway 502. Verified live that the test fails on a real mismatch and passes on the current, correct Dockerfile. No DB dependency, no docs drift, no scope creep. This PR carries bookie's standard per-PR patch version bump (0.8.2 → 0.8.3) and `CHANGELOG.md` entry, per `CLAUDE.md`'s per-change flow — "no release" (per instruction) means skipping the `/release` ceremony (version *promotion*, tag, GitHub Release), not skipping the version bump itself. Clear to proceed to `/commit`.
