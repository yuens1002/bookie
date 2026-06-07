# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- **Segment model** + `manage_segments` tool — segments (Personal, Rental, a gig, a side business…) are a table, each its own P&L and tax filing (Schedule C / E / none), combinable at year-end and extensible without code changes.
- `Property` model + `manage_properties` tool; `add_transaction` accepts `propertyId` and `query_transactions` returns it (per-property Schedule E tracking).
- `split_transaction` tool — one balanced entry with a single payment leg + N category legs (a receipt split across categories/segments); the payment leg is what reconciliation matches against a statement.
- `delete_transaction` tool — remove a journal entry and its postings (correct mistakes / duplicate imports).
- Default seed reorganized into Personal / Sole Proprietorship (Sch C) / Rental Real Estate (Sch E); accounts carry a `segmentId` + `taxLine`.
- Example bank-statement CSVs under `examples/csv/` (synthetic fixtures for the importer).
- Vitest suite: `src/lib/money.test.ts` (unit) + `test/ledger.test.ts` (integration over the MCP tools — double-entry invariant, splits incl. income, property tagging, deletes, segment management). `npm test` / `npm run test:watch`.
- `CONTRIBUTING.md` — setup, conventions, and test workflow.

### Changed
- Replaced the binary `personal|business` account flag with the Segment model: income/expense accounts carry a `segmentId` (+ `taxLine`), bank/card accounts stay segment-neutral (one card spans segments); `manage_accounts`/`account_balances` use `segmentId` instead of `entity`. Units are not tracked (properties are).
- Reworded the project tagline (README + `package.json`) so "personal and business finances" (scope) and "double-entry accounting" (method) read as two distinct ideas, not one compound term.

### Fixed
- `toMinor("")` (and blank/whitespace strings) now throws instead of silently returning `$0`.

## [0.1.0] — 2026-06-03
### Added
- Project scaffold: MCP server with dual transport (stdio + Streamable HTTP over Hono).
- Neon Postgres persistence via Prisma; seeded US sole-proprietor chart of accounts (auto-seed on first run).
- Double-entry ledger and tools: `manage_accounts`, `add_transaction`, `query_transactions`, `account_balances`.
- Integer-cent money utilities; bearer-token auth for the HTTP transport.
- Auto-generated tool reference (`npm run docs:tools`).
- Docs: README, Architecture, Roadmap, Changelog. Dockerfile + railway.json for deploy.

[Unreleased]: https://example.com/compare/v0.1.0...HEAD
[0.1.0]: https://example.com/releases/tag/v0.1.0
