# /review report — server.json version drift fix

**Branch:** `fix/server-json-version-drift` (uncommitted, pre-PR)
**Generated:** 2026-07-03
**Iterations to reach verified:** 1

## Structural exception (no in-repo plan)

Lighter cadence, no plan doc — a one-line data fix caught by a test failing on `main`. De-facto owning role:

- `/backend-architect` (project-local) — owns `server.json`'s content correctness.

## Verdict

**Clear — with a mid-fix design correction.** `server.json`'s `version`/`packages[0].version` were behind (`0.8.4` vs the just-released `0.8.5`), caught by `test/server-json.test.ts` failing on `main` exactly as designed. Fixing the *value* first exposed that the *test's invariant itself* was wrong: it compared `server.json`'s version against `package.json`'s version, but this project bumps `package.json` on every PR (not just releases) — so `package.json` is normally ahead of whatever's actually live on npm. That comparison would fail on nearly every subsequent PR, not just genuine drift. Confirmed live: bumping `package.json` to `0.8.6` in this very branch made the original test fail again immediately, before any real drift existed. Rewrote the test to compare against `CHANGELOG.md`'s latest dated `## [X.Y.Z]` heading instead — written only by `/release`, so it's the actual source of truth for "what's really published" — not `package.json`'s current, often-unreleased value.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| Fix version drift | `server.json:9,14` (reverted to `0.8.5`, matching what's live) | ✓ shipped |
| Fix the test's invariant, not just the value | `test/server-json.test.ts` — version checks now compare against `CHANGELOG.md`'s latest released heading instead of `package.json`'s version | ✓ shipped |
| Changelog entry | `CHANGELOG.md` → `[Unreleased] → Fixed` | ✓ shipped |

## Verification

- `npx vitest run test/server-json.test.ts` — 4/4 pass, both against the current correct state (`package.json` at `0.8.6`, `server.json` correctly still at `0.8.5`) and reverified live: corrupted `server.json`'s version to `0.8.9`, reran (2 failures), reverted (4/4 pass again).
- `mcp-publisher validate` against the live registry API — ✅ valid.
- `npm run typecheck` — clean.

## Docs drift

None.

## Recommendations

None outstanding. Once merged, the MCP Registry `mcp-publisher publish` step (deferred pending this fix, per the human's prior go-ahead) can proceed against `main` with `server.json` correctly pointing at `0.8.5`, which is confirmed live on npm — and the test will no longer false-positive on the next PR's routine version bump.

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"In a project where every PR bumps `package.json`'s version (not just release PRs), `package.json`'s version is a forward-looking 'next candidate,' not 'what's currently published.' Any regression test that asserts another file's version must equal `package.json`'s version will spuriously fail on the very next routine PR — the correct comparison target is whatever file/heading is written only by the release process itself (here, `CHANGELOG.md`'s latest dated `## [X.Y.Z]` section, since only `/release` writes those). Before adding a cross-file version-sync test, identify which side of the comparison is release-scoped and which is PR-scoped — comparing two PR-scoped values for equality is the bug, not the fix."*
  **Triggered by:** Copilot's originally-correct-sounding suggestion (extend the Dockerfile-style sync check to `server.json` vs `package.json` version) produced a test that would have failed on nearly every future PR, discovered only by bumping the version live in this branch and watching the "already fixed" test fail again.

## Ready for Review

- /review report: `docs/plans/server-json-version-drift-fix-review.md`

One paragraph: `server.json`'s version fields were one release-bump behind `package.json` (`0.8.4` vs `0.8.5`) — caught immediately by the regression test added two PRs ago, exactly as intended. Fixed, verified against the live registry API and the test suite. Clear to proceed to `/commit`.
