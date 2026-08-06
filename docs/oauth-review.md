# /review report — OAuth 2.0 + Railway deployment (ad-hoc session)

**Branch:** `main` (direct commits — no PR) → follow-up: PR #17 (`fix/oauth-mcp-root-alias-and-docs`, v0.6.1)
**Generated:** 2026-06-13 (snapshot taken *before* PR #17 landed — F1, F3, and the `.gitignore` item were fixed in that PR)
**Commits reviewed:** `6ef3152`, `ba9f484`, `7686e89` + uncommitted diff on `src/transports/http.ts` (committed in PR #17)

**Structural exception:** No plan doc or ACs exist for this work — it was ad-hoc. De-facto owning roles: `/backend-architect` (OAuth implementation, schema) and `/devops` (Railway config, deploy docs). Recommendations below are phrased as additions to those role skill files.

---

## Verdict

**Major issues — follow-up PR required before this is done.**  
The OAuth implementation is functionally correct and deployed, but skipped the branch → PR → Copilot → review flow entirely. Several real defects (missing env var docs, open redirect, no tests, an uncommitted fix already on Railway) would normally have been caught there.

---

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| Railway `startCommand` fix | `railway.json:7` — removed `prisma db push` | ✓ shipped |
| Neon pooled-URL docs | `docs/DEPLOYING.md:16` | ✓ shipped (but incomplete — see F3) |
| OAuth metadata endpoints | `src/transports/http.ts:56-74` | ✓ shipped |
| `/authorize` PKCE endpoint | `src/transports/http.ts:76-90` | ✓ shipped (see F4) |
| `/token` endpoint | `src/transports/http.ts:92-135` | ✓ shipped |
| `src/lib/oauth.ts` — auth codes, PKCE, JWT, refresh tokens | `src/lib/oauth.ts:1-113` | ✓ shipped (see F5, F6) |
| `OAuthToken` Prisma model | `prisma/schema.prisma:159-170` | ✓ shipped |
| Dual-auth on `/mcp` (static key OR JWT) | `src/transports/http.ts:155-167` | ✓ shipped |
| `/token` form-body fix (RFC 6749) | `src/transports/http.ts:93-96` | ✓ shipped |
| `/mcp` root alias for Claude.ai | `src/transports/http.ts:196-197` | ✓ shipped in PR #17 (was uncommitted at review time) |

### Code changes not tied to any deliverable

- `AGENTS.md` (untracked at review time) — Codex-equivalent of CLAUDE.md; was not in `.gitignore`. ✓ Fixed in PR #17.

---

## ACs ↔ Tests (Gate 3 spot-check)

No tests were written for any OAuth deliverable. The test gap is MAJOR.

| Missing coverage | Why it matters |
|-----------------|----------------|
| `issueAuthCode` / `consumeAuthCode` TTL and single-use | Code-under-test has a 5-min window; a bug here grants unlimited reuse |
| `verifyPKCE` S256 correctness | Cryptographic invariant — if the comparison is broken, any verifier passes |
| `rotateRefreshToken` replay detection | Replay-revoke-all is the security guarantee; untested means unknown |
| `verifyAccessToken` with expired / malformed JWT | Silent `return null` path — easy to break without noticing |
| `/mcp` dual-auth path (JWT accepted, static key rejected, neither rejected) | The financial data gate — regression risk every time `http.ts` is touched |
| `/token` form-encoded vs JSON dispatch | Just fixed; has no test; will silently regress |

---

## Docs drift

| Doc | Line | Stale claim | Contradicting code |
|-----|------|-------------|-------------------|
| `docs/DEPLOYING.md` | 13-21 | Env var table has no mention of `PUBLIC_URL`, `JWT_SECRET`, `OAUTH_CLIENT_ID` | `src/transports/http.ts:53-54` reads both; `src/lib/oauth.ts:40-43` throws if `JWT_SECRET` unset |
| `docs/DEPLOYING.md` | 70 | "The `/mcp` endpoint enforces…rate limit" | Rate limit now also runs on `/` (POST) via shared handler |
| `.gitignore` | — | `CLAUDE.md` and `.claude/` are gitignored; `AGENTS.md` is not | `AGENTS.md` shows as untracked |

---

## Findings

### F1 — Uncommitted fix diverges git from Railway (MAJOR) — ✓ fixed in PR #17
The `/` POST alias (`app.post("/", mcpHandler)`) was deployed to Railway via `railway up` but was not committed to git at the time of this review. Fixed by PR #17 (`fix/oauth-mcp-root-alias-and-docs`, v0.6.1).

### F2 — Pre-existing test failure: `bookie://reports/{year}` resource (MAJOR — pre-existing)
`test/resources-prompts.test.ts > contains the monthly summary table header` fails with `SyntaxError: Unexpected token 'I'` — the resource is returning a Prisma/validation error instead of JSON. Not introduced by OAuth (no overlap with `src/domain/report.ts`), but the test suite is broken and should be fixed before the next feature.

### F3 — `docs/DEPLOYING.md` missing OAuth env vars (MAJOR — docs drift) — ✓ fixed in PR #17
`PUBLIC_URL`, `JWT_SECRET`, and `OAUTH_CLIENT_ID` were absent from the deploy guide's env-var table. Fixed by PR #17 which added all three vars to the table and a Claude.ai connector setup section.

### F4 — Open redirect in `/authorize` (MINOR — security)
`redirect_uri` is accepted as-is with no allowlist check:
```typescript
const location = new URL(redirect_uri ?? "https://claude.ai/api/mcp/auth_callback");
```
A crafted auth URL with a malicious `redirect_uri` sends the auth code to an attacker. PKCE still protects the token (code alone is useless without the verifier), but the code is a 32-byte secret that shouldn't leak. For a single-owner tool the risk is low (the attacker must phish the owner), but RFC 6749 §10.6 requires validation.

**Fix:** allowlist `redirect_uri` against `process.env.ALLOWED_REDIRECT_URIS` (or a hardcoded constant `"https://claude.ai/api/mcp/auth_callback"` since only one client exists).

### F5 — No rate limiting on `/token` (MINOR)
`/token` accepts unlimited requests. Auth codes are 256-bit random so brute-force is infeasible, but a flood of requests to `/token` can exhaust DB connection pool slots (each request calls `prisma.oAuthToken.create`). The existing `checkRateLimit` helper is 3 lines to apply.

### F6 — Expired refresh tokens accumulate forever (MINOR — operational)
`rotateRefreshToken` marks old tokens `consumed: true` but never deletes them. `issueRefreshToken` adds a new row every OAuth session. Over time `oauth_tokens` grows unbounded. The `@@index([expiresAt])` is there; a periodic `deleteMany({ where: { expiresAt: { lt: new Date() } } })` (e.g. in the same `setInterval` that cleans auth codes) would be enough.

> **⚠️ Superseded — do not apply the `setInterval` remedy above.** It was implemented as
> suggested and caused an outage: a 60-second query kept the serverless Postgres compute
> from ever scaling to zero, consuming ~94% of the monthly compute allowance while idle.
> When the allowance ran out the compute suspended, refresh-token lookups failed, and the
> connector could not re-authenticate. The finding itself was valid; the *timer-based*
> remedy was not. Expired rows are now purged opportunistically on token issuance —
> see `docs/plans/oauth-idle-compute-plan.md`.

---

## Recommendations

1. **Commit + PR the `/` alias fix** (F1) — this is the next immediate action; the fix is already deployed but not in git.
2. **Fix `docs/DEPLOYING.md`** (F3) — add OAuth env vars and connector setup section in the same PR as F1.
3. **Add `AGENTS.md` to `.gitignore`** — one-line fix, same PR.
4. **Write OAuth tests** (F2 gap) — `verifyPKCE`, `rotateRefreshToken` replay, dual-auth `/mcp` path, `/token` dispatch. Minimum bar before this is considered done.
5. **Add `redirect_uri` allowlist to `/authorize`** (F4) — low effort, meaningful defence-in-depth.
6. **Investigate pre-existing `bookie://reports/{year}` failure** (pre-existing F2) — separate PR; not OAuth-related.
7. **Add expired-token cleanup** (F6) — extend the existing `setInterval` in `oauth.ts`.

---

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"OAuth and auth-middleware changes have no shorter review exemption than tool handlers. Before staging any `src/lib/auth*.ts`, `src/lib/oauth*.ts`, or auth-path changes to `src/transports/http.ts`: (a) write tests for every code path including the negative cases (wrong client_id, expired code, replay, JWT verify failure); (b) open a PR and get Copilot review — financial data gates are higher-stakes than tool logic, not lower."*
  **Triggered by:** F1 + test gap — entire OAuth implementation merged to `main` without tests or PR review.

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"When accepting a `redirect_uri` parameter in an OAuth authorize endpoint, validate it against an explicit allowlist before redirecting. For single-client setups, a hardcoded constant or env var (`ALLOWED_REDIRECT_URIS`) is sufficient. Accepting any `redirect_uri` is an open-redirect vulnerability per RFC 6749 §10.6."*
  **Triggered by:** F4 — `/authorize` passes `redirect_uri` through without validation.

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** ~~*"When OAuth refresh tokens are stored in the DB, add a cleanup path for expired rows in the same `setInterval` that purges in-memory state. A token rotation scheme with no expiry cleanup will grow `oauth_tokens` without bound. Pattern: `prisma.oAuthToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })` inside the existing cleanup interval, wrapped in `.catch(() => {})` so a DB hiccup doesn't kill the interval."*~~
  **⚠️ SUPERSEDED — do not apply.** This principle was never absorbed into
  `.claude/commands/backend-architect.md`, but the code change it describes was made and
  caused an outage (see the F6 note above). Replacement principle: *"Never put a recurring
  database query on a timer when the database is serverless/scale-to-zero. A periodic query
  resets the idle countdown, so the compute never suspends and burns its allowance while
  doing nothing. Do the housekeeping opportunistically on an event that already touches the
  DB — for `oauth_tokens`, on token issuance, which is the only event that adds rows."*
  **Triggered by:** F6 — `oauth_tokens` has no expiry cleanup.

- **Route:** `/devops` → `~/.claude/commands/devops.md` (global, no project override)
  **Draft principle:** *"Deployment hygiene: after any `railway up` (or equivalent deploy-from-local-worktree), verify that the deployed changes are also committed to git. If not, the next git-triggered deploy silently rolls back the fix. The invariant: `git diff HEAD` should be empty before calling a Railway deployment 'done'."*
  **Triggered by:** F1 — `/` POST alias was deployed to Railway but not committed; git and Railway diverged.

- **Route:** `/devops` → `~/.claude/commands/devops.md`
  **Draft principle:** *"When adding new required env vars to a server, update `docs/DEPLOYING.md`'s env var table in the same commit. `.env.example` and the deploy doc must stay in sync — the deploy doc is what a new deployer reads; `.env.example` alone is not sufficient."*
  **Triggered by:** F3 — `PUBLIC_URL`, `JWT_SECRET`, `OAUTH_CLIENT_ID` added to `.env.example` but not to `docs/DEPLOYING.md`.

---

## Ready for Review

The OAuth implementation is live and deployed but **not done** in the `/commit`-flow sense:

- **Immediate:** commit the `/` alias + docs fix + `.gitignore` entry as one PR → get Copilot review → merge
- **Follow-up:** OAuth test suite PR
- **Pre-existing:** investigate `bookie://reports/{year}` test failure
