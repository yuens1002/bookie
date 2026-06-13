# Deploying bookie

bookie runs as a single Node.js process (Streamable HTTP MCP transport) against a Neon Postgres database. The recommended stack is Railway + Neon + Resend.

## Prerequisites

- [Railway](https://railway.app) account
- [Neon](https://neon.tech) account with a production branch
- [Resend](https://resend.com) account with a verified sender (for `send_report`)

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOOKIE_DB_URL` | Yes | Neon **pooled** connection string (for the running server) |
| `BOOKIE_DB_DIRECT_URL` | Yes | Neon **pooled** connection string (same value as `BOOKIE_DB_URL` — Railway cannot reach Neon's direct endpoint) |
| `BOOKIE_API_KEY` | Yes | Bearer token — the LLM client sends `Authorization: Bearer <key>` |
| `PUBLIC_URL` | For Claude.ai connector | Public HTTPS base URL of the deployed server, no trailing slash (e.g. `https://your-app.up.railway.app`) |
| `JWT_SECRET` | For Claude.ai connector | 64-char hex secret for HS256 JWT signing — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `OAUTH_CLIENT_ID` | For Claude.ai connector | Client ID allowlisted for the connector (default: `claude-ai-connector`) |
| `OAUTH_CLIENT_SECRET` | Recommended | Single-owner gate: if set, `/token` requires a matching `client_secret`. Enter this value in the "OAuth Client Secret" field in Claude.ai connector settings. Generate with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |
| `OAUTH_REDIRECT_URIS` | For Claude.ai connector | Comma-separated allowlist of permitted `redirect_uri` values (default: `https://claude.ai/api/mcp/auth_callback`) |
| `PORT` | No | HTTP port (default: 3000; Railway sets this automatically) |
| `RESEND_API_KEY` | For `send_report` | Resend API key (`re_...`) from the Resend dashboard |
| `RESEND_FROM` | For `send_report` | Verified sender address (e.g. `Bookie <books@yourdomain.com>`) |
| `RATE_LIMIT_RPM` | No | Max `/mcp` requests per minute per IP (default: 60) |

## Neon setup

1. Create a project at [neon.tech](https://neon.tech).
2. The default `main` branch is your **production** branch.
3. From **Connection Details**, copy the **pooled** connection string and use it for **both** `BOOKIE_DB_URL` and `BOOKIE_DB_DIRECT_URL`. Railway's network cannot reach Neon's direct (non-pooled) endpoint.
4. The schema must be pushed manually before the first deploy (and after any future schema change):
   ```bash
   railway run --service bookie npx prisma db push
   ```
5. Default chart of accounts seeds on first startup if the `Account` table is empty.

> **Local dev:** create a Neon `dev` branch and point your `.env` there so test data never touches the production branch.

## Railway deploy

1. Push your fork to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo** → select your fork.
3. Railway auto-detects `Dockerfile` and `railway.json`.
4. Set all required env vars under **Variables**.
5. Railway builds and starts the container. The deploy log shows:
   ```
   bookie MCP server ready on http://localhost:<PORT>/mcp
   ```
6. Smoke-test the health endpoint:
   ```bash
   curl https://<your-app>.up.railway.app/health
   # → {"ok":true,"service":"bookie","transport":"http"}
   ```
7. Verify auth on the MCP endpoint:
   ```bash
   curl -X POST https://<your-app>.up.railway.app/mcp \
     -H "Authorization: Bearer <BOOKIE_API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}'
   ```
   A 200 with an MCP initialize response confirms auth and DB connectivity.

## Claude.ai connector setup (OAuth)

1. Set `PUBLIC_URL`, `JWT_SECRET`, `OAUTH_CLIENT_ID`, and `OAUTH_CLIENT_SECRET` in Railway Variables (see table above).
2. Run the schema migration to create the `oauth_tokens` table:
   ```bash
   railway run --service bookie npx prisma db push
   ```
3. In Claude.ai → Settings → Connectors → **Add custom connector**:
   - **URL:** `https://<your-app>.up.railway.app` (base URL — no suffix)
   - **OAuth Client ID:** `claude-ai-connector` (or whatever you set in `OAUTH_CLIENT_ID`)
   - **OAuth Client Secret:** the value of `OAUTH_CLIENT_SECRET`
4. Claude.ai redirects you to `/authorize` → you approve → access token is issued automatically.
5. Claude.ai will now call bookie tools in conversation.

> **Note:** `BOOKIE_API_KEY` and OAuth coexist. Claude Desktop uses the static key; Claude.ai uses OAuth JWT tokens. Both are valid on the same deployed server.

## Railway Bucket setup (for receipt file storage)

Receipt file storage (`manage_receipts` with `fileContent`) uses Railway's built-in S3-compatible object storage.

1. In your Railway project, click **New** → **Storage Bucket**.
2. Give it a name (e.g. `bookie-receipts`) and click **Create**.
3. In the bucket's **Connect** tab, click **Add to Service** → select your bookie service.
   Railway automatically injects `ENDPOINT`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, and `REGION` into the service environment.
4. Redeploy the service — file upload and signed URL retrieval will be available automatically.

> **Without a bucket:** structured receipt data (merchant, date, total, line items) is always stored; only the raw file upload feature is gated on the bucket being configured. The tool returns a clear error if `fileContent` is provided but the bucket vars are absent.

## Resend setup (for `send_report`)

1. Create an account at [resend.com](https://resend.com).
2. Add and verify your sending domain (or use Resend's sandbox for initial testing).
3. Create an API key → set as `RESEND_API_KEY`.
4. Set `RESEND_FROM` to a verified sender: `Bookie <books@yourdomain.com>`.
5. `send_report` returns `fail()` with a clear message if either var is missing at call time.

## Rate limiting and audit logging

The `/mcp` endpoint enforces a per-IP in-memory fixed-window rate limit (default 60 req/min). Tune with `RATE_LIMIT_RPM`. The `/health` endpoint is exempt.

Each `/mcp` request is logged to stderr in JSON: `{"ts":"…","ip":"…","method":"…","toolName":"…"}`. Railway captures stderr in the deploy logs.
