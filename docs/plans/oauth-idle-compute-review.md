# /review report — oauth idle-compute & metadata

**Branch:** `fix/oauth-idle-compute-and-metadata`
**Generated:** 2026-08-06
**Iterations to reach verified:** 1

## Verdict

**Clear, with two docs-drift items found and fixed during review.** All 7 ACs pass, the
full suite is green (242 tests), and the root-cause assumption was validated empirically
rather than assumed. Ready for human review.

## Structural exception — no in-repo feature plan at start

This is a patch on the lighter cadence (per `CLAUDE.md`, the full agentic-workflow ceremony
is skipped for this repo), so there was no pre-existing plan with a deliverables table.
A plan was authored up front anyway because `CLAUDE.md`'s process notes require a named
plan doc + threat-model note before any auth-adjacent code lands:
`docs/plans/oauth-idle-compute-plan.md`.

**De-facto owning roles** (how `/retro` routing was derived):
- `/backend-architect` — the timer removal, purge placement, metadata correction
- `/test-engineer` — the regression guards in `test/oauth.test.ts`

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|---|---|---|
| D1 — remove the 60s housekeeping timer | `src/lib/oauth.ts` (timer + `cleanupInFlight` deleted) | ✓ shipped |
| D2 — sweep auth codes on issue | `src/lib/oauth.ts:10-22` (`issueAuthCode`) | ✓ shipped |
| D3 — purge expired tokens on issuance | `src/lib/oauth.ts:73-97` (`purgeExpiredTokens` + `issueRefreshToken`) | ✓ shipped |
| D4 — DRY `rotateRefreshToken` | `src/lib/oauth.ts:115` (delegates to `issueRefreshToken`) | ✓ shipped |
| D5 — correct OAuth metadata | `src/transports/http.ts:80-84` | ✓ shipped |
| D6 — plan + threat model | `docs/plans/oauth-idle-compute-plan.md` | ✓ shipped |

### Code changes not tied to any deliverable

- `package.json` — version bump 0.8.8 → 0.8.9 (required by `CLAUDE.md` per-PR policy)
- `CHANGELOG.md` — two `[Unreleased] / Fixed` entries (required by the same policy)
- `docs/ARCHITECTURE.md`, `docs/oauth-review.md` — docs drift found *by* this review (below)

No scope creep. Notably **not** touched: `.env` (the production-ledger mislabel) and the
stale "dev branch" comments in `test/setup.ts` — deferred to a separate branch by explicit
decision.

## ACs ↔ Tests (Gate 3 spot-check)

| AC | Test / check | Asserts invariant? | Notes |
|---|---|---|---|
| AC-1 no timer remains | `grep setInterval src/lib/oauth.ts` | ✓ | zero matches |
| AC-2 purge on issuance | `test/oauth.test.ts` "purges already-expired tokens…" | ✓ | plants an expired row, calls `issueRefreshToken`, asserts the expired row is gone **and** the new one survived — asserts the relation, not a literal |
| AC-3 purge failure can't break issuance | code review | ✓ | `purgeExpiredTokens` catches internally, never rethrows |
| AC-4 rotation still works | existing rotation + replay tests | ✓ | pass unchanged after the DRY refactor — meaningful, since rotation now delegates |
| AC-5 auth codes expire | `test/oauth.test.ts` "rejects a code past its 5-minute TTL" | ✓ | fake timers assert both sides of the boundary (4 min accepted, 6 min rejected) |
| AC-6 metadata advertises `client_secret_post` | `test/oauth.test.ts` metadata block | ✓ | asserts presence **and** absence of `"none"` |
| AC-7 compute can suspend | empirical, dev branch | ✓ | suspended at ~6.1 min with an open idle connection |

### Note on AC-6's test shape

The metadata is constructed inline inside `startHttp()`, so it is asserted by reading
`src/transports/http.ts` as source text rather than by booting the server. This follows
existing repo precedent for sync-invariants (`test/dockerfile.test.ts`,
`test/server-json.test.ts`) rather than introducing a new pattern. The paired test also
asserts `/token` *still enforces* `client_secret`, so the two halves of the contract must
move together — this is what stops the same drift recurring in the opposite direction.

**Residual weakness (accepted):** a source-text assertion cannot catch a runtime override.
Boot-the-app coverage would be stronger but requires extracting the metadata document to a
pure function — a refactor deliberately deferred as out of scope for a patch.

## Docs drift

Two found, both fixed in this branch:

| Location | Problem | Fix |
|---|---|---|
| `docs/ARCHITECTURE.md:33` | Claimed "Expired rows are purged on a 60-second cleanup interval" — describes the removed timer | Rewritten to describe opportunistic purge + *why* a timer is wrong here |
| `docs/oauth-review.md:88,123` | A prior `/review` report **recommended** the `setInterval` remedy, and carried it as a draft `/retro` principle for `/backend-architect` | Both marked ⚠️ SUPERSEDED with the outage explanation; the draft principle is struck through and replaced with the inverted lesson |

**The `docs/oauth-review.md` finding is the important one.** That document is the origin of
this bug: F6 correctly identified unbounded token growth, then prescribed a timer-based
remedy that was implemented as written. Verified that the draft principle was **never
absorbed** into `.claude/commands/backend-architect.md` (grep: no matches for
`setInterval`/`cleanup`/`oauth_tokens`), so the retro loop did not propagate it — but the
document itself remained live guidance that would have reproduced the bug.

## Recommendations

1. **Merge as-is.** No blocking findings.
2. Follow-up branch (already agreed): correct `.env`'s branch mislabel and the "Neon dev
   branch" comments in `test/setup.ts` + `test/oauth.test.ts` — the suite currently runs
   against the production ledger.
3. Consider a follow-up for the pre-existing flake: one full-suite run failed
   `report.test.ts` with a Prisma error, then passed in isolation and on re-run. Parallel
   test files each opening a client against a 0.25 CU compute is the likely cause.
   Unrelated to this change, but it will keep recurring.

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"Never put a recurring database query on a timer when the database
  is serverless / scale-to-zero. Any periodic query resets the provider's idle countdown,
  so the compute never suspends and burns its allowance doing nothing — a 60-second
  interval consumed ~94% of a monthly allowance while completely idle. Do housekeeping
  opportunistically on an event that already touches the database (for row-expiry cleanup,
  on the insert path that creates rows), and let an unused server issue zero queries."*
  **Triggered by:** the root cause of this outage — `docs/oauth-review.md` F6's remedy.

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"When an endpoint's behaviour is gated on an env var, its published
  discovery/capability metadata must be derived from — or tested against — the same
  condition. A metadata document that contradicts enforcement is invisible while the gate
  is inert and only surfaces once the gate goes live."*
  **Triggered by:** `token_endpoint_auth_methods_supported: ["none"]` staying accidentally
  accurate for weeks because the secret sat under an old variable name.

- **Route:** cross-cutting → `/review` protocol itself
  **Draft addition:** *"When a change reverses a remedy that a prior `/review` report
  recommended, Step 3's drift scan must include that report — and check whether its draft
  `/retro` principle was absorbed into the owning role's skill file. A superseded remedy
  left unmarked in an old report is live guidance that will be re-applied."*
  **Triggered by:** `docs/oauth-review.md` F6 — the origin of the bug being fixed here.

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"When a fix rests on an assumption about third-party infrastructure
  behaviour that the vendor's docs do not state (does suspension key off queries or
  connections? does this cache evict on write?), measure it against a non-production
  instance before shipping. An unverified infra assumption produces a fix that changes no
  numbers and looks correct in every test."*
  **Triggered by:** AC-7 — Neon's docs do not define "inactive"; the 6.1-minute suspension
  with an open idle connection was measured, not assumed.
