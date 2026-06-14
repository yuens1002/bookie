# bookie

> A Model Context Protocol (MCP) server that keeps the books for your **personal and business finances** using **double-entry accounting** — driven entirely from an LLM. No UI: Claude or GPT *is* the interface.

Import bank-statement CSVs, categorize spending (including photographed receipts), reconcile monthly, and generate US **Schedule C** tax reports — by asking your assistant. Runs locally over stdio or remotely over HTTP so a mobile consumer LLM can reach it.

## Why no UI?

The host LLM already reads CSVs, sees receipt images, and writes prose. Bookie owns the things an LLM *shouldn't* improvise: a correct double-entry ledger, integer-cent money math, deterministic categorization rules, and reproducible reports. The model handles language and vision; the server handles the books.

## Quick start (local, stdio)

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # then fill in BOOKIE_DB_URL / BOOKIE_DB_DIRECT_URL (Neon)
npm run db:push             # apply schema to your Neon database
npm run dev                 # starts on stdio; seeds the default chart on first run
```

Register it with any MCP-capable environment (Claude Desktop, Cursor, VS Code, or any host that supports the MCP stdio transport). Point `BOOKIE_DB_URL` at your **one shared Neon DB** — the same value the deployed HTTP server uses — so every client shares one ledger.

Example: Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bookie": {
      "command": "node",
      "args": ["/absolute/path/to/bookie/dist/index.js"],
      "env": {
        "BOOKIE_DB_URL": "postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require",
        "BOOKIE_DB_DIRECT_URL": "postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require"
      }
    }
  }
}
```

(Run `npm run build` first to produce `dist/index.js`, or substitute `tsx src/index.ts` for development.)

## Quick start (remote, HTTP — for mobile LLMs)

```bash
npm run build
BOOKIE_TRANSPORT=http BOOKIE_API_KEY=$(openssl rand -hex 32) npm start
# Streamable HTTP endpoint: POST http://localhost:3000/mcp  (also POST / — used by Claude.ai)
# Health check:             GET  http://localhost:3000/health
```

Deploy to Railway with the included `Dockerfile` / `railway.json` (the start command runs `prisma db push` then boots). See [docs/DEPLOYING.md](docs/DEPLOYING.md) for the full walkthrough (Railway + Neon + Resend setup, env var reference).

## Tools

The full, always-current tool reference lives in [`docs/TOOLS.md`](docs/TOOLS.md) (regenerate with `npm run docs:tools`). Today:

| Tool | What it does |
|------|--------------|
| `manage_accounts` | Create/list/archive accounts (segment-scoped categories carry a tax line) |
| `add_transaction` | Record one balanced double-entry (money flows from → to) |
| `split_transaction` | One payment leg + N category legs (a receipt split across categories) |
| `import_transactions` | Import a bank/card CSV as balanced entries — preview → confirm, with dedup |
| `manage_rules` | Create/list/delete/test/suggest auto-categorization rules (categorize → account/property, or exclude) that power import-preview suggestions; `action=suggest` scans past categorizations and returns candidate rules for descriptions with 2+ occurrences |
| `categorize_transaction` | Re-categorize the income/expense leg of an existing entry — explicit account or apply a stored rule |
| `reconcile` | Match a bank/card statement CSV against the ledger and mark postings cleared — preview then commit |
| `manage_receipts` | Attach, list, delete, or get a signed download URL for receipt data; optionally upload the original file (JPEG, PNG, WEBP, HEIC, or PDF) to Railway Bucket storage |
| `generate_report` | Monthly reconciliation summary, or fiscal-year Schedule C / Schedule E tax P&L |
| `export_report` | Render any report as markdown or CSV |
| `send_report` | Run a report and email it via Resend |
| `query_transactions` | List entries + postings by date range / account |
| `account_balances` | Current balance per account |

## Resources

Bookie exposes two MCP resources that an LLM can read without calling a tool:

| Resource URI | MIME type | What it contains |
|-------------|-----------|-----------------|
| `bookie://accounts` | `application/json` | All active accounts with their current balances |
| `bookie://reports/{year}` | `text/markdown` | Annual fiscal snapshot: Schedule C, Schedule E, and a one-row-per-month summary (opening balance, net income, cleared postings count) |

## Prompts

Three canned workflow prompts guide the LLM through common bookkeeping tasks:

| Prompt | Parameters | Purpose |
|--------|-----------|---------|
| `monthly-close` | `year`, `month` | Step-by-step month-end close: import CSV → categorize → reconcile → report → (optional) email |
| `categorize-uncategorized` | _(none)_ | Find journal entries with no income/expense leg and walk through categorizing each |
| `prepare-tax-summary` | `year` | Generate Schedule C + E, export as markdown and CSV, optionally email |

## Configuration

See [`.env.example`](.env.example) for the full reference. Key variables:

| Variable | Purpose |
|----------|---------|
| `BOOKIE_TRANSPORT` | `stdio` (default) or `http` |
| `BOOKIE_DB_URL` | Neon pooled connection string |
| `BOOKIE_DB_DIRECT_URL` | Neon direct connection string (for `db push`) |
| `BOOKIE_API_KEY` | Static Bearer token (Claude Desktop / direct API) |
| `PUBLIC_URL` | Public HTTPS base URL of the deployed server (Claude.ai connector) |
| `JWT_SECRET` | HS256 signing secret for OAuth JWT access tokens |
| `OAUTH_CLIENT_ID` | OAuth client ID (default: `claude-ai-connector`) |
| `OAUTH_CLIENT_SECRET` | Single-owner gate: `/token` requires a matching `client_secret` |
| `RESEND_API_KEY` | Resend API key for `send_report` |
| `AWS_ENDPOINT_URL` / `AWS_S3_BUCKET_NAME` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_DEFAULT_REGION` | Railway Bucket credentials — auto-injected when you connect a bucket to the service (use AWS SDK Generic style); enables receipt file upload in `manage_receipts` |

## Docs

- [Architecture](docs/ARCHITECTURE.md) — data model, transports, layering
- [Deploying](docs/DEPLOYING.md) — Railway + Neon + Resend setup
- [Roadmap](docs/ROADMAP.md) — phased plan
- [Changelog](docs/CHANGELOG.md) — what shipped
- [Releasing](docs/RELEASING.md) — versioning + release process
- [Tools](docs/TOOLS.md) — generated manual
- [Contributing](CONTRIBUTING.md) — setup, conventions, tests

## Safety

Bookie stores financial data in your Neon Postgres database; connection strings live in `.env` (gitignored) and Railway env vars — never commit them. The HTTP transport requires auth on every `/mcp` request: either a static Bearer token (`BOOKIE_API_KEY`) or an OAuth JWT issued by the `/token` endpoint. Always set at least one before exposing the server beyond localhost. See [docs/DEPLOYING.md](docs/DEPLOYING.md) for the full Claude.ai connector OAuth setup.

## License

MIT
