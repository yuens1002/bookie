# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

## [0.5.0] — 2026-06-13

### Added
- Per-request rate limiting on the HTTP transport: fixed-window per-IP, configurable via `RATE_LIMIT_RPM` env var (default 60 rpm), returns 429 on excess. Exempt: `/health`. Rate limit applied before auth to guard against unauthenticated floods.
- Audit logging on the HTTP transport: each `/mcp` request logs `{ts, ip, method, toolName}` to stderr in JSON. Captured by Railway deploy logs.
- `send_report` tool — run any report (`monthly-reconciliation`, `schedule-c`, `schedule-e`) and email it as markdown via Resend. Requires `RESEND_API_KEY` + `RESEND_FROM` env vars; fails fast with a clear message if either is missing. Same parameter contract as `generate_report`. Completes P4 delivery.
- `docs/DEPLOYING.md` — step-by-step Railway + Neon production-branch + Resend setup guide; env var reference table.

## [0.4.0] — 2026-06-13

### Added
- `generate_report` extended with `type='schedule-c'` and `type='schedule-e'` modes — fiscal-year P&L for sole-proprietor (Schedule C) and rental real estate (Schedule E) segments. Schedule C groups income/expense accounts by `taxLine`; Schedule E groups by property then by `taxLine`. Null `taxLine` → "Unclassified" bucket; entries without `propertyId` on Schedule E accounts → "Unassigned" property bucket. Pure domain engines in `src/domain/tax.ts`. Completes P3 tax reports.
- `export_report` tool — render any report (`monthly-reconciliation`, `schedule-c`, `schedule-e`) as `markdown` (human-readable) or `csv` (spreadsheet-ready). Re-fetches data fresh; no need to call `generate_report` first.

## [0.3.0] — 2026-06-13

### Added
- `manage_receipts` tool — attach, list, and delete structured receipt data against a journal entry. The client LLM extracts `merchant`, `date`, `total`, and `lineItems` from a receipt image or text; this tool stores them (line-item amounts converted to minor units). One entry can hold multiple receipts. Completes P2 Increment 2.
- `generate_report` tool — `type='monthly-reconciliation'`: computes opening/closing balance for an optional bank/card account, income and expense totals grouped by segment, uncategorized entries (no income/expense leg flagged for review), and uncleared payment postings (discrepancies). Report logic is pure and deterministic in `src/domain/report.ts`.
- `reconcile` tool — match a bank/card statement CSV against payment-leg postings and mark them cleared. Two-step: `mode='preview'` (parse + match + report discrepancy buckets; **writes nothing**) then `mode='commit'` (set `cleared=true` + `statementRef` on matched postings). Idempotent: already-cleared postings are reported in an `alreadyCleared` bucket but not re-written. Reports three buckets: `matched` / `onStatementNotInLedger` / `inLedgerNotOnStatement`. Uses the same CSV profiles as `import_transactions`. Pure match engine in `src/domain/reconcile.ts`. Completes P2 Increment 1.
- `cleared Boolean @default(false)` and `statementRef String?` added to the `Posting` model (reconcile schema migration).

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

[Unreleased]: https://github.com/yuens1002/bookie/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/yuens1002/bookie/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/yuens1002/bookie/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yuens1002/bookie/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yuens1002/bookie/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yuens1002/bookie/releases/tag/v0.1.0
