# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-06-10
### Added
- `manage_rules` tool + auto-categorization in import — a rule matches a case-insensitive description substring and either routes the line to a category account (`categorize`, optionally tagging a rental property) or marks it to skip on import (`exclude`); higher priority wins, ties break on longer pattern. `import_transactions` preview now shows a per-row `suggested` rule match. Commit still requires explicit `mappings` — rules **suggest**, never auto-post.
- `import_transactions` tool — import a bank/card statement CSV as balanced double-entry in two steps: `mode='preview'` (parse + dedup + flag possible matches; **writes nothing**) then `mode='commit'` (write the per-row category `mappings`). Shape-based, neutrally-named profiles (`signed-amount`, `debit-credit`, `rental-export`) parsed with an RFC-4180 parser (`csv-parse`) that handles quoted fields, embedded newlines, and pre-signed/categorized amount columns. Content-hash `external_id` makes re-import idempotent (same-file duplicate lines kept distinct); amount+date "possible-match" flagging keeps receipt-first entries from being double-posted.
- **Segment model** + `manage_segments` tool — segments (Personal, Rental, a gig, a side business…) are a table, each its own P&L and tax filing (Schedule C / E / none), combinable at year-end and extensible without code changes.
- `Property` model + `manage_properties` tool; `add_transaction` accepts `propertyId` and `query_transactions` returns it (per-property Schedule E tracking).
- `split_transaction` tool — one balanced entry with a single payment leg + N category legs (a receipt split across categories/segments); the payment leg is what reconciliation matches against a statement.
- `delete_transaction` tool — remove a journal entry and its postings (correct mistakes / duplicate imports).
- Default seed reorganized into Personal / Sole Proprietorship (Sch C) / Rental Real Estate (Sch E); accounts carry a `segmentId` + `taxLine`.
- Example bank-statement CSVs under `examples/csv/` (synthetic fixtures for the importer).
- Vitest suite: `src/lib/money.test.ts` (unit) + `test/ledger.test.ts` (integration over the MCP tools — double-entry invariant, splits incl. income, property tagging, deletes, segment management). `npm test` / `npm run test:watch`.
- `CONTRIBUTING.md` — setup, conventions, and test workflow.

### Changed
- Extended the (previously unused) `Rule` model — `RuleAction` enum (`categorize` / `exclude`), nullable `accountId` (null for `exclude`), optional `propertyId`, and a `priority` index. Groundwork for the categorization-rules engine (`manage_rules` + import auto-suggestion) landing next.
- Replaced the binary `personal|business` account flag with the Segment model: income/expense accounts carry a `segmentId` (+ `taxLine`), bank/card accounts stay segment-neutral (one card spans segments); `manage_accounts`/`account_balances` use `segmentId` instead of `entity`. Units are not tracked (properties are).
- Reworded the project tagline (README + `package.json`) so "personal and business finances" (scope) and "double-entry accounting" (method) read as two distinct ideas, not one compound term.
- README tool table now lists `split_transaction` and `import_transactions`; "CSV import" moved from the roadmap line to shipped.

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

[Unreleased]: https://github.com/yuens1002/bookie/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/yuens1002/bookie/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yuens1002/bookie/releases/tag/v0.1.0
