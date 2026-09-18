# /review report — OAuth timing-safe secret comparison

**Branch:** `fix/oauth-timing-safe-comparison`
**Generated:** 2026-09-18
**Iterations to reach verified:** 1

## Verdict

**Clear.** All new assertions verified non-vacuous by reverting each fix and observing the
matching test fail; full suite green (274 tests, up from 253); no docs drift found. Ready for
human review.

## Structural exception — no in-repo feature plan at start

This is a patch on the lighter cadence (per `CLAUDE.md`, the full agentic-workflow ceremony is
skipped for this repo), so there was no pre-existing plan with a deliverables table. A plan was
authored up front anyway, per `CLAUDE.md`'s and `.claude/commands/backend-architect.md`'s (gate
30) requirement that any auth/token-handling change get a named plan + threat-model note before
code lands: `docs/plans/oauth-timing-safe-comparison-plan.md`.

**De-facto owning roles** (how `/retro` routing would be derived):
- `/backend-architect` — the timing-safe comparison, the unconditional client_secret gate,
  the `buildHttpApp()`/`startHttp()` split
- `/test-engineer` — the new behavioral `/token` tests, `requireAuth` coverage, replacing the
  fragile source-text regex test

## Deliverables ↔ Code (mapped from the plan's two problem statements)

| Problem | Implementation | Docs touched? | Status |
|---|---|---|---|
| P1 — timing-unsafe comparisons | `src/lib/crypto.ts` (new, `timingSafeEqual` extracted from `oauth.ts`); `src/lib/auth.ts:10,19`; `src/transports/http.ts:9,143` | N (no external-facing behavior change) | ✓ shipped |
| P2 — conditional client_secret enforcement | `src/transports/http.ts:131-144` (`/token` now refuses `500` when `OAUTH_CLIENT_SECRET` unset, matching `/authorize`) | N (README/DEPLOYING.md already described `/token` as validating the secret; neither claimed the conditional-skip behavior, so nothing to correct) | ✓ shipped |
| Testing — replace fragile regex test, add real coverage | `src/transports/http.ts:53` (`buildHttpApp()` export); `test/oauth.test.ts` (+159/-9 lines: `/token` behavioral tests, `requireAuth` tests) | N/A (test-only) | ✓ shipped |

### Code changes not tied to any deliverable
- `package.json`, `package-lock.json` — version bump 0.8.14 → 0.8.15 (required by `CLAUDE.md` per-PR policy)
- `CHANGELOG.md` — one `[Unreleased] / Fixed` entry covering both problems + the test replacement

## ACs ↔ Tests (adapted — no formal ACs doc; mapped against the plan's own "Testing" section)

| Plan requirement | Test | Asserts invariant? | Notes |
|---|---|---|---|
| No `client_secret` → 401 | `test/oauth.test.ts` "rejects refresh_token grant with no client_secret, then accepts..." | ✓ | Differential pair: same token, reject then retry with correct secret — proves the 401 didn't consume the token and was caused solely by the missing secret |
| Wrong `client_secret` → 401 | "rejects refresh_token grant with the wrong client_secret" | ✓ | Same differential-pair shape |
| Non-string `client_secret` → 401 not 500 | "rejects a non-string client_secret with 401, not 500" | ✓ | Reverting just the `typeof` guard reproduces a 500 — confirmed live |
| `OAUTH_CLIENT_SECRET` unset → 500 | "refuses /token entirely when OAUTH_CLIENT_SECRET is unset, matching /authorize" | ✓ | Reverting just this fix reproduces a 400 (old conditional-skip behavior) — confirmed live, the one test genuinely tied to the *behavioral* fix rather than the timing property |
| `requireAuth` correct/wrong/missing key, unset `BOOKIE_API_KEY` | `describe("requireAuth", ...)`, 4 cases | ✓ | Pure-function unit tests, no HTTP layer needed |

**Note on the timing-safety property itself:** none of the above (nor any test) asserts that the
comparison is actually constant-time — that's not practically assertable via a functional test.
The tests above assert round-trip correctness of the *replacement* implementation (accept the
right value, reject the wrong one), which is what a revert-and-confirm-fails check can prove;
the timing property itself is a property of `crypto.timingSafeEqual` (Node's own primitive),
not of this diff's logic.

## Docs drift

### Stale claims (contradiction)
None. `README.md:146` and `docs/DEPLOYING.md:21,71,79` already describe `/token` as validating
`OAUTH_CLIENT_SECRET` — neither claimed or relied on the old conditional-skip behavior, so
nothing they say became false. The old fragile test asserted an implementation detail
(`body.client_secret !== requiredSecret`), not a doc — already handled above by replacing it.

### Missing updates (omission)
None. This is a hardening fix with no change to the documented external contract (same routes,
same error shapes for the paths users would exercise correctly, same env var names) — no README
table, TOOLS.md row, or ARCHITECTURE.md component description needs a new entry.

### Internal consistency (doc ↔ doc, doc ↔ itself)
Checked `docs/plans/oauth-timing-safe-comparison-plan.md` against what shipped (3d, implemented-
plan spec scan): the plan's stated design (move `timingSafeEqual` to `src/lib/crypto.ts`, gate
`/token` unconditionally, split `buildHttpApp()`) matches the diff exactly — no deviation to
record. Re-ran this check after the last fix commit (there was only one implementation pass, no
fix-round commits on this branch yet).

## Docs hygiene / public-voice audit

None. No private repo/org/agency/client/tenant names, individual PII, or personalized-voice
prose introduced by this diff — new content in `docs/plans/oauth-timing-safe-comparison-plan.md`
and the `CHANGELOG.md` entry is generic technical description, matching this repo's existing
plan-doc voice (see `oauth-idle-compute-plan.md` for the established style).

## Recommendations

None blocking. Two things worth the maintainer's judgment call, not fixed here since the plan
scoped them out explicitly:

1. `src/lib/auth.ts`'s doc comment describes the *startup* guard (`hasStaticKey || hasJwtSecret`)
   correctly, but doesn't mention that `requireAuth`'s own comparison is now timing-safe — a
   one-line addition, optional, since the code itself is the more authoritative source here.
2. The plan's "Out of scope" section correctly excludes the OAuth grant flows themselves (PKCE,
   rotation, replay detection) — those were already correct and already tested, and this review
   found nothing in this diff that touches them.

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"A secret/credential comparison (API key, client_secret, any bearer
  token check) must use this repo's `timingSafeEqual` (`src/lib/crypto.ts`), never `===`/`!==`
  directly — grep for bare equality against `process.env.*_KEY`/`*_SECRET` values when adding or
  reviewing any new auth check. A conditional enforcement gate (`if (requiredSecret && ...)`)
  that silently no-ops when the required env var is unset is equivalent to no gate at all for
  that state — prefer an explicit 'refuse if unconfigured' branch (matching this repo's existing
  `/authorize` pattern) over a check that degrades gracefully into an open door."*
  **Triggered by:** both problems this review covers — found via a cross-repo audit prompted by
  a similar bug (missing `EXECUTE` revocation on a Postgres RPC) in a sibling project
  (resume-agent), not by a Copilot finding or an incident in this repo.

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"A test asserting security-relevant HTTP behavior (auth rejection,
  secret validation) should call the real route via `app.request()` against an exported
  `buildHttpApp()`-style builder, not grep source text for the literal comparison operator or
  variable name. A source-text match breaks for the wrong reason the moment the implementation
  is refactored (even when the behavior is preserved or improved), and can't distinguish 'this
  regressed' from 'this got fixed.'"*
  **Triggered by:** the pre-existing `"still enforces client_secret at /token"` test, which
  matched `/body\.client_secret\s*!==\s*requiredSecret/` and would have failed on this exact fix.
