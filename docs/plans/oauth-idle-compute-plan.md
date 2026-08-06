# Plan — OAuth housekeeping timer & metadata correction

**Branch:** `fix/oauth-idle-compute-and-metadata`
**Scope:** `src/lib/oauth.ts`, `src/transports/http.ts`, `test/oauth.test.ts`
**Type:** patch (bug fix, no behaviour change to the auth contract)

## Problem 1 — the housekeeping timer prevents database scale-to-zero

`src/lib/oauth.ts` runs a module-scope `setInterval` every 60 s that issues a
`deleteMany` against `oauth_tokens`:

```ts
setInterval(() => {
  ...
  prisma.oAuthToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })
}, 60_000).unref();
```

The managed Postgres provider suspends a compute after 5 minutes of inactivity.
A query every 60 s means the compute **never accumulates 5 idle minutes**, so it
runs continuously whether or not anyone is using the server.

Measured on the deployed instance: **129.2 active compute-hours in a ~127-hour
billing window** — i.e. permanently awake. At the provider's smallest compute
size this is ~180 CU-hours/month against a 191.9 CU-hour monthly allowance, or
~94 % of the budget consumed doing nothing. Any additional development work
pushes it over, which is what happened (allowance exhausted mid-cycle; the
compute suspended; token refresh then failed).

The table this timer maintains gains roughly **one row per day** on a
single-owner deployment. It does not need minute-resolution housekeeping.

### Design

Remove the timer entirely and do the same work opportunistically.

1. **Expired refresh tokens** — purge on token *issuance* rather than on a clock.
   Issuance is the only event that adds rows, so it is the natural moment to
   drop expired ones, and it is a rare path (initial authorization + hourly
   refresh) rather than a fixed 1440 queries/day.

   The purge is **awaited but error-swallowed**. Housekeeping must never be able
   to fail an auth exchange — that failure mode is precisely the outage this
   change exists to prevent — so the delete is wrapped in `try/catch` and its
   failure is logged, not propagated.

   Awaiting rather than firing-and-forgetting costs one indexed `DELETE` on a
   single-owner table (milliseconds, on a path that runs at most hourly) and buys
   determinism: the purge is directly assertable in a test instead of being a
   floating promise that races test teardown.

2. **In-memory auth codes** — sweep expired entries inside `issueAuthCode`.
   Codes are only ever added there, so sweeping at insert bounds the map without
   a timer. `consumeAuthCode` already rejects expired entries independently, so
   correctness never depended on the sweep.

3. **DRY** — `rotateRefreshToken` currently duplicates `issueRefreshToken`'s
   create-a-token logic inline. Rotation delegates to `issueRefreshToken`, so
   the purge lives in exactly one place and the duplication disappears.

### Why not simply lengthen the interval

A 6- or 24-hour timer would still wake the compute on a schedule unrelated to
use, and would still be a timer whose period has to be reasoned about against
the provider's suspension window. Removing the clock removes the whole class of
problem: with no timer, an unused server issues **zero** queries and the compute
suspends normally.

## Problem 2 — OAuth metadata advertises the wrong client-auth method

`/.well-known/oauth-authorization-server` publishes:

```json
"token_endpoint_auth_methods_supported": ["none"]
```

but `/token` rejects any exchange whose body lacks a matching `client_secret`
(`401 invalid_client`). The metadata therefore tells a client to send no client
authentication, while the endpoint requires it.

This was latent: the deployment's secret was set under an **older variable name**
that the code had stopped reading, so the validation branch never executed and
the metadata was accidentally accurate. Once the variable was corrected, the
contradiction became live.

The current connector works because it sends its configured secret regardless of
the advertised methods. Any client that trusts the metadata would fail.

### Design

Publish `["client_secret_post"]` — the secret is sent in the request body, which
is what RFC 6749 §2.3.1 calls this method.

The value is unconditional, not derived from whether `OAUTH_CLIENT_SECRET` is
set: `/authorize` already refuses to run at all without that variable, so any
deployment where OAuth functions is a deployment where the secret is required.
A conditional would encode a state that cannot occur.

## Threat model

| Consideration | Assessment |
|---|---|
| **Token lifetime / revocation** | Unchanged. TTLs, one-time-use rotation, and replay-revokes-all-client-tokens are untouched. Purging only removes rows already past `expiresAt`, which `rotateRefreshToken` independently rejects. |
| **Purge failure** | Cannot affect auth. Fire-and-forget with `.catch`; the exchange has already completed. Worst case is expired rows lingering until the next issuance — harmless, and they are still rejected on use. |
| **Slower purge cadence** | Expired rows may persist longer on an idle server. They are unusable (`expiresAt` is checked on every rotation) and the table is single-owner scale. `token_hash` is `@unique` and `expires_at` is indexed, so lookup cost is unaffected by a few stale rows. |
| **Auth-code map growth** | `/authorize` is reachable without credentials, so a visitor can mint codes into the in-memory map. Sweeping on insert bounds it to codes issued within the 5-minute TTL — the same bound the timer provided. Codes are opaque, single-use, and PKCE-bound, so an unconsumed entry grants nothing. |
| **Metadata correction** | Strictly narrowing: it advertises a requirement the endpoint already enforces. No endpoint becomes more permissive. `["none"]` was the misleading value. |
| **Data exposure** | None. No change to what any endpoint returns, to token contents, or to `requireAuth`. |

## Acceptance criteria

| AC | What | How | Pass |
|----|------|-----|------|
| AC-1 | No timer remains in `src/lib/oauth.ts` | `grep -n "setInterval" src/lib/oauth.ts` | No matches |
| AC-2 | Expired tokens are purged on issuance | `test/oauth.test.ts` | Insert an expired row, call `issueRefreshToken`, assert the expired row is gone and the new one remains |
| AC-3 | A purge failure cannot break issuance | Code review | `purgeExpiredTokens` catches and logs internally and never rethrows; `issueRefreshToken` resolves with a valid token regardless of purge outcome |
| AC-4 | Rotation still works end to end | existing `test/oauth.test.ts` rotation + replay cases | Pass unchanged |
| AC-5 | Auth codes still expire | existing auth-code cases + a sweep case | Expired entries are removed on next issue; `consumeAuthCode` still rejects expired |
| AC-6 | Metadata advertises `client_secret_post` | `test/oauth.test.ts` | `token_endpoint_auth_methods_supported` equals `["client_secret_post"]` |
| AC-7 | Compute can suspend | Empirical — see below | Endpoint reaches `idle` with no traffic |

## Empirical validation of the root cause

The fix assumes suspension keys off **query activity**, not off open
connections. If an idle pooled connection alone kept the compute awake,
removing the timer would not change the number and the pool lifetime would have
to change too.

Tested directly against the non-production `dev` branch: open a client, run one
query, then hold the connection open and idle while polling the endpoint state.

```
[0.0m] wake query OK — connection now open and will stay IDLE
[1.1m] endpoint state: active
...
[5.1m] endpoint state: active
[6.1m] endpoint state: idle
```

**Result: the compute suspended at ~6.1 minutes while an idle connection was
still open.** Suspension keys off *query* activity, not open connections — so
removing the timer is sufficient on its own, and no connection-pool or driver
change is required. The provider's docs do not state this either way, which is
why it was measured rather than assumed.

