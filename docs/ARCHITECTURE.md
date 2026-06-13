# Architecture

Bookie is a single Node/TypeScript MCP server with two interchangeable transports and a Neon Postgres double-entry ledger (via Prisma).

## Layers

```
LLM host (Claude / GPT)         ← language + vision (OCR, prose, intent)
        │  MCP (stdio | Streamable HTTP)
        ▼
Transport     src/transports/*   ← stdio.ts, http.ts (Hono + @hono/node-server)
        ▼
MCP server    src/server.ts      ← registers tools (capabilities)
        ▼
Tools         src/tools/*        ← one file per tool group; Zod input schemas
        ▼
Domain        src/domain/*       ← csv, categorization, reconciliation, tax (deterministic)
        ▼
Data          src/db/*           ← Prisma client; schema in prisma/schema.prisma
```

**Separation principle:** the host LLM does language and vision; the server does the ledger, money math, deterministic rules, and reports. Receipts are OCR'd by the *client*; tools receive already-structured fields, never an image.

## Data model (double-entry)

- **segments** — a line of business (or "personal"); each is its own P&L and tax filing via `taxSchedule` (C / E / null = personal), combinable at year-end and extensible without code changes.
- **accounts** — chart of accounts. `type` ∈ asset/liability/equity/income/expense. Income/expense accounts *are* the spending categories and carry a `segmentId` (+ `taxLine`, the specific Schedule line); asset/liability/equity accounts are usually segment-neutral (one card spans segments).
- **properties** — a rental property (Schedule E is filed per property; units are not tracked). `journal_entries.propertyId` tags rental entries.
- **journal_entries** — one balanced transaction (date, description, memo, source, `external_id` for import dedup, optional `propertyId`).
- **postings** — legs of an entry. `amount` is **signed integer minor units** (cents): debit positive, credit negative. Postings of an entry always sum to zero.
- **rules** — auto-categorization: a case-insensitive description substring maps to an action — `categorize` (a target account, optionally a property) or `exclude` (skip the line on import). Priority-ordered.
- **receipts** — structured receipt data linked to an entry. `fileKey` holds the Railway Bucket object key when the original file was uploaded; `mimeType` records its type. Signed download URLs (1-hour TTL) are generated on demand via `manage_receipts action='get_url'`.
- **oauth_tokens** — hashed refresh tokens for the Claude.ai connector OAuth flow. `tokenHash` (SHA-256 hex), `clientId`, `expiresAt` (30-day TTL), `consumed` flag for rotation + replay detection. Expired rows are purged on a 60-second cleanup interval.

`add_transaction` is sugar over postings: "money flows FROM account A TO account B" creates a debit on B (+) and a credit on A (−).

## Money

All amounts are integer minor units. Conversion to/from dollars happens only at tool boundaries and report rendering (`src/lib/money.ts`). No floating-point arithmetic touches the ledger.

## Transports

- **stdio** (`BOOKIE_TRANSPORT=stdio`, default) — for Claude Desktop and local CLI clients. stdout is the protocol channel; logs go to stderr.
- **Streamable HTTP** (`BOOKIE_TRANSPORT=http`) — Hono app. Stateless: a fresh MCP server + transport per request. Suitable for mobile consumer LLMs and Railway deploys.

  **Endpoints:**
  - `POST /mcp` and `POST /` — MCP handler (both paths accepted; Claude.ai POSTs to the connector base URL `/`)
  - `GET /health` — liveness check
  - `GET /.well-known/oauth-authorization-server` — OAuth 2.0 server metadata (RFC 8414)
  - `GET /.well-known/oauth-protected-resource` — resource metadata
  - `GET /authorize` — issues an auth code (PKCE S256 required; `redirect_uri` allowlisted)
  - `POST /token` — exchanges code or refresh token for a JWT access token + refresh token

  **Auth:** Two credentials are accepted on `/mcp`:
  - Static Bearer token: `Authorization: Bearer <BOOKIE_API_KEY>` — for Claude Desktop / direct API clients
  - JWT Bearer token: issued by `/token` via OAuth 2.0 Authorization Code + PKCE — for Claude.ai connector. JWTs are HS256, 1-hour TTL, signed with `JWT_SECRET`. Refresh tokens are stored hashed in the `oauth_tokens` table with rotation + replay detection.

Both transports share `buildServer()` — they never differ in capability.

## Persistence

Schema lives in `prisma/schema.prisma` and is applied with `npm run db:push` (and on deploy via the container start command). `src/db/seed.ts` seeds a default US sole-proprietor chart of accounts when the ledger is empty; both transports call it through `src/transports/bootstrap.ts` on startup. `src/db/client.ts` exports a single `PrismaClient`.

Money is stored as `Int` minor units (cents) in `amount`/`total`; never floats.

### One DB — every instance points at the one and only

There is a **single Neon Postgres ledger**. Every instance — the local stdio server, the deployed HTTP server, any future instance — sets `BOOKIE_DB_URL` to the **same** database, so the books are always identical no matter how you reach them. There is no local copy and nothing to reconcile.

| Connection | Env | Used by |
|------------|-----|---------|
| Pooled | `BOOKIE_DB_URL` (`…-pooler.…neon.tech`) | runtime queries (Prisma client) |
| Direct | `BOOKIE_DB_DIRECT_URL` | `prisma db push` / migrations |

We use **Neon branches** to separate environments while keeping one schema: the `production` branch is the real ledger; a `dev` branch backs local development and tests (and ephemeral branches can back CI). Trade-off of one remote primary: the stdio server needs network connectivity and pays a small per-query round-trip — in exchange, exactly one set of books.

## Blob storage (Railway Bucket)

Receipt files (JPEG, PNG, WEBP, HEIC, PDF) are stored in a Railway-managed S3-compatible bucket (backed by Tigris). The server uses `@aws-sdk/client-s3` with Railway's injected credentials (`ENDPOINT`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`). Files are private; access is via presigned GET URLs (1-hour TTL). Logic lives in `src/domain/blob.ts`. The feature degrades gracefully — if bucket vars are absent, structured receipt data still saves; only `fileContent` upload is blocked.

## Docs stay in sync

`scripts/gen-tools-doc.ts` connects an in-memory MCP client to the live server and dumps the registered tool schemas to `docs/TOOLS.md`. The manual cannot drift from the code.
