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

Register it with Claude Desktop (`claude_desktop_config.json`). Point `BOOKIE_DB_URL` at your **one shared Neon DB** — the same value the deployed HTTP server uses — so local and mobile share one ledger:

```json
{
  "mcpServers": {
    "bookie": {
      "command": "node",
      "args": ["/absolute/path/to/bookie/dist/index.js"],
      "env": {
        "BOOKIE_DB_URL": "postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require"
      }
    }
  }
}
```

(Run `npm run build` first, or point `command` at `npx`/`tsx` for dev.)

## Quick start (remote, HTTP — for mobile LLMs)

```bash
npm run build
BOOKIE_TRANSPORT=http BOOKIE_API_KEY=$(openssl rand -hex 32) npm start
# Streamable HTTP endpoint: POST http://localhost:3000/mcp
# Health check:            GET  http://localhost:3000/health
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
| `manage_rules` | Create/list/delete/test auto-categorization rules (categorize → account/property, or exclude) that power import-preview suggestions |
| `categorize_transaction` | Re-categorize the income/expense leg of an existing entry — explicit account or apply a stored rule |
| `reconcile` | Match a bank/card statement CSV against the ledger and mark postings cleared — preview then commit |
| `manage_receipts` | Attach, list, or delete structured receipt data (merchant, date, line items) against an entry |
| `generate_report` | Monthly reconciliation summary, or fiscal-year Schedule C / Schedule E tax P&L |
| `export_report` | Render any report as markdown or CSV |
| `send_report` | Run a report and email it via Resend |
| `query_transactions` | List entries + postings by date range / account |
| `account_balances` | Current balance per account |

## Configuration

See [`.env.example`](.env.example). Key variables: `BOOKIE_TRANSPORT`, `BOOKIE_DB_URL` (+ `BOOKIE_DB_DIRECT_URL`), `BOOKIE_API_KEY`, `RESEND_API_KEY`.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — data model, transports, layering
- [Deploying](docs/DEPLOYING.md) — Railway + Neon + Resend setup
- [Roadmap](docs/ROADMAP.md) — phased plan
- [Changelog](docs/CHANGELOG.md) — what shipped
- [Releasing](docs/RELEASING.md) — versioning + release process
- [Tools](docs/TOOLS.md) — generated manual
- [Contributing](CONTRIBUTING.md) — setup, conventions, tests

## Safety

Bookie stores financial data in your Neon Postgres database; connection strings live in `.env` (gitignored) and Railway env vars — never commit them. The HTTP transport is **open unless `BOOKIE_API_KEY` is set** — always set it before exposing the server beyond localhost.

## License

MIT
