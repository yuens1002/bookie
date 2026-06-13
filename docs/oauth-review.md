# /review report — OAuth 2.0 + Railway deployment (ad-hoc session)

**Branch:** `main` (direct commits — no PR)
**Generated:** 2026-06-13
**Commits reviewed:** `6ef3152`, `ba9f484`, `7686e89` + uncommitted diff on `src/transports/http.ts`

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
| `/mcp` root alias for Claude.ai | `src/transports/http.ts:196-197` | **uncommitted** (F1) |

### Code changes not tied to any deliverable

- `AGENTS.md` (untracked) — Codex-equivalent of CLAUDE.md; not in `.gitignore`. Needs a gitignore entry before the next commit or it will be staged accidentally.

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

### F1 — Uncommitted fix diverges git from Railway (MAJOR)
The `/` POST alias (`app.post("/", mcpHandler)`) is deployed to Railway via `railway up` but is **not committed to git**. The repo and the running server are out of sync. Next deploy from git will roll back this fix.

**Fix:** commit and PR the current working tree diff on `src/transports/http.ts`.

### F2 — Pre-existing test failure: `bookie://reports/{year}` resource (MAJOR — pre-existing)
`test/resources-prompts.test.ts > contains the monthly summary table header` fails with `SyntaxError: Unexpected token 'I'` — the resource is returning a Prisma/validation error instead of JSON. Not introduced by OAuth (no overlap with `src/domain/report.ts`), but the test suite is broken and should be fixed before the next feature.

### F3 — `docs/DEPLOYING.md` missing OAuth env vars (MAJOR — docs drift)
`PUBLIC_URL`, `JWT_SECRET`, and `OAUTH_CLIENT_ID` are absent from the deploy guide's env-var table. Someone cloning and deploying from the README/docs has no Claude.ai connector support and no indication why. The `.env.example` was updated but the deploy doc was not.

**Fix:** add a "Claude.ai connector (OAuth)" section to the env var table and a connector setup sub-section explaining the `/mcp` URL and manual client ID step.

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
  **Draft principle:** *"When OAuth refresh tokens are stored in the DB, add a cleanup path for expired rows in the same `setInterval` that purges in-memory state. A token rotation scheme with no expiry cleanup will grow `oauth_tokens` without bound. Pattern: `prisma.oAuthToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })` inside the existing cleanup interval, wrapped in `.catch(() => {})` so a DB hiccup doesn't kill the interval."*
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
