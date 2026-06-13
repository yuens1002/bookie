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
| `BOOKIE_DB_DIRECT_URL` | Yes | Neon **direct** connection string (for `prisma db push` on deploy) |
| `BOOKIE_API_KEY` | Yes | Bearer token — the LLM client sends `Authorization: Bearer <key>` |
| `PORT` | No | HTTP port (default: 3000; Railway sets this automatically) |
| `RESEND_API_KEY` | For `send_report` | Resend API key (`re_...`) from the Resend dashboard |
| `RESEND_FROM` | For `send_report` | Verified sender address (e.g. `Bookie <books@yourdomain.com>`) |
| `RATE_LIMIT_RPM` | No | Max `/mcp` requests per minute per IP (default: 60) |

## Neon setup

1. Create a project at [neon.tech](https://neon.tech).
2. The default `main` branch is your **production** branch.
3. From **Connection Details**, copy two strings:
   - **Pooled connection** → `BOOKIE_DB_URL`
   - **Direct connection** → `BOOKIE_DB_DIRECT_URL`
4. The schema applies automatically on first deploy via `npx prisma db push` (in `railway.json`'s `startCommand`). No manual migration step needed.
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

## Resend setup (for `send_report`)

1. Create an account at [resend.com](https://resend.com).
2. Add and verify your sending domain (or use Resend's sandbox for initial testing).
3. Create an API key → set as `RESEND_API_KEY`.
4. Set `RESEND_FROM` to a verified sender: `Bookie <books@yourdomain.com>`.
5. `send_report` returns `fail()` with a clear message if either var is missing at call time.

## Rate limiting and audit logging

The `/mcp` endpoint enforces a per-IP in-memory fixed-window rate limit (default 60 req/min). Tune with `RATE_LIMIT_RPM`. The `/health` endpoint is exempt.

Each `/mcp` request is logged to stderr in JSON: `{"ts":"…","ip":"…","method":"…","toolName":"…"}`. Railway captures stderr in the deploy logs.
