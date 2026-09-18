# Plan — timing-safe secret comparison + unconditional client_secret enforcement

**Branch:** `fix/oauth-timing-safe-comparison`
**Scope:** `src/lib/auth.ts`, `src/lib/oauth.ts`, `src/transports/http.ts`, `test/oauth.test.ts`
**Type:** patch (bug fix, no behaviour change to the auth contract for a correctly-configured deployment)

## Threat model

bookie is single-owner, but the HTTP transport is a real network-facing endpoint (Railway or
any other public host) protecting full read/write access to someone's financial ledger. Two
credentials guard it: `BOOKIE_API_KEY` (static bearer, Claude Desktop) and the OAuth
`client_secret` (Claude.ai connector, via `/token`). Both are the sole gate between an
anonymous network caller and the ledger.

## Problem 1 — two secret comparisons are not timing-safe

- `src/lib/auth.ts`'s `requireAuth` compares the provided `BOOKIE_API_KEY` with `===`.
- `src/transports/http.ts`'s `/token` handler compares `client_secret` with `!==`
  (`body.client_secret !== requiredSecret`).

Both leak comparison time proportional to the matching prefix length, in principle allowing an
attacker to recover the secret byte-by-byte over many requests. The repo already has a
constant-time helper, `timingSafeEqual`, defined in `src/lib/oauth.ts` and correctly used
there for PKCE verification (`verifyPKCE`) — it just isn't used for either of these two checks.

**Fix:** move `timingSafeEqual` to a new `src/lib/crypto.ts` (a generic utility, not
OAuth-specific — `auth.ts` importing it from `oauth.ts` would be an odd layering direction).
Both `auth.ts` and `oauth.ts` import it from there. Use it in both places above.

**Type-safety note:** `timingSafeEqual` hashes both arguments via `crypto.createHash`, which
throws on a non-string input. `requireAuth`'s `provided` is already guarded (`if (provided && ...)`
before the compare). `/token`'s `body.client_secret` is not — the body is cast to
`Record<string, string>` after `parseBody()`/`c.req.json()`, but that cast is a compile-time
assertion, not a runtime guarantee: a JSON body like `{"client_secret": 123}` parses fine and
reaches this line as a number. Must add an explicit `typeof body.client_secret === "string"`
guard before calling `timingSafeEqual`, or a malformed request turns a clean `401` into an
unhandled `500`.

## Problem 2 — client_secret enforcement is conditional on it currently being set, not required

`/authorize` refuses to run at all when `OAUTH_CLIENT_SECRET` is unset (returns `500` — "only
the owner can authorize"). `/token`'s check is weaker:

```ts
const requiredSecret = process.env.OAUTH_CLIENT_SECRET;
if (requiredSecret && body.client_secret !== requiredSecret)
  return c.json({ error: "invalid_client" }, 401);
```

If `OAUTH_CLIENT_SECRET` is ever unset after being set (env var removed, redeploy without it,
config drift), `requiredSecret` is falsy and the whole check no-ops — every grant type,
including `refresh_token`, proceeds with no client authentication at all. A refresh token
issued while the secret *was* set could then be rotated indefinitely with nothing but
possession of that token. `/authorize`'s gate protects new codes; it does not protect existing
refresh tokens once the secret is removed.

**Fix:** `/token` gates the same way `/authorize` already does — if `OAUTH_CLIENT_SECRET` isn't
configured, refuse outright (`500`, matching `/authorize`'s existing error shape) rather than
silently skipping the check. When it is configured, the comparison is mandatory and
timing-safe for every grant type.

## Testing

`test/oauth.test.ts` currently has one test for this exact enforcement, and it's a source-text
regex match against the literal `!==` comparison (`expect(httpSrc).toMatch(/body\.client_secret\s*!==\s*requiredSecret/)`)
— this fix's diff removes that exact string, so the test would fail for the wrong reason (a
refactor, not a regression) unless replaced. Per this repo's own retro-sourced test-quality
bar (asserting an implementation detail instead of the underlying behavior), replace it with a
real behavioral test against `/token` instead of grepping source text.

`src/transports/http.ts` currently builds the Hono `app` and calls `serve()` in the same
function (`startHttp`), with no way to reach `app` for testing without opening a real port.
Split `buildHttpApp()` (registers every route, returns the app) out of `startHttp()` (calls
`buildHttpApp()`, then `serve()`s it) — Hono apps support `.request()` directly against routes
with no listener, so this is what makes a real POST `/token` test possible without spinning up
an actual server process.

New/changed cases in `test/oauth.test.ts`:
- No `client_secret` in the body → `401 invalid_client` (when `OAUTH_CLIENT_SECRET` is set)
- Wrong `client_secret` → `401 invalid_client`
- Non-string `client_secret` (JSON body, e.g. a number) → `401`, not `500`
- Correct `client_secret` → the grant proceeds (differential-pair style: same request, only the
  secret changes, proving the check is what's deciding the outcome)
- `OAUTH_CLIENT_SECRET` unset entirely → `/token` refuses with `500`, matching `/authorize`
- `BOOKIE_API_KEY` requireAuth: correct key accepted, wrong key rejected, still timing-safe
  (behavioral coverage of the comparison outcome — a timing-safety property itself isn't
  practically assertable in a unit test, so this proves round-trip correctness after switching
  the implementation, not the timing property)

All new secret-check tests use a differential-pair shape (reject with wrong/missing secret,
then immediately retry the identical request with the correct one) to prove the fix's own
correctness and non-vacuousness, matching this project's existing test style elsewhere in this
file (`consumeAuthCode`'s second-consume check, `rotateRefreshToken`'s reuse-after-rotation
check).

## Out of scope

- No change to the OAuth grant flows themselves (PKCE, rotation, replay detection) — those are
  already correct and already tested.
- No change to `BOOKIE_API_KEY`'s own startup requirement — `startHttp`'s existing guard
  (`hasStaticKey || hasJwtSecret`) is unrelated to this fix and stays as-is.
