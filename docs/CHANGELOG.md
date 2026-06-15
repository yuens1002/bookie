# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `manage_receipts action='attach'` now supports a presigned PUT upload path: pass `mimeType` without `fileContent` to get `{ receiptId, fileKey, uploadUrl, expiresIn }` — the client uploads bytes directly to storage via `curl -T receipt.jpg "<uploadUrl>"`. Works from any client regardless of base64 capacity (Claude.ai web, ChatGPT mobile, etc.). The existing inline `fileContent` path is unchanged.
- `src/domain/blob.ts` — `getSignedUploadUrl(key, mimeType, ttlSecs?)` helper (symmetric with `getSignedDownloadUrl`).
- `docs/DEPLOYING.md` — "Uploading receipt files from a mobile device" section with step-by-step presigned PUT flow.

### Changed

### Fixed
- `import_transactions`: CC/card (liability) accounts now produce correct double-entry postings — a positive CSV charge credits the card and debits the expense; a negative credit/refund debits the card and credits the expense. Previously the signs were inverted, causing CC expenses to appear as negative amounts in reports.
- Receipt file upload failed with "Region is missing" even when the Railway Bucket was correctly connected. AWS SDK v3 only auto-reads `AWS_REGION`, not the `AWS_DEFAULT_REGION` that Railway injects (the `AWS_DEFAULT_REGION` fallback was v2-only), so `S3Client` resolved no region. `src/domain/blob.ts` now passes `region` explicitly (`AWS_REGION` → `AWS_DEFAULT_REGION` → `"auto"`) and uses `||` so empty-string env vars also fall back correctly.

## [0.7.0] — 2026-06-14

### Added
- Receipt file storage via Railway Bucket: `manage_receipts action='attach'` now accepts optional `fileContent` (base64) + `mimeType` (JPEG, PNG, WEBP, HEIC, or PDF) to upload the original receipt image or PDF to S3-compatible object storage; a signed download URL (1-hour TTL) is returned. New `action='get_url'` refreshes the URL on demand. `action='delete'` removes the stored file alongside the DB row. `action='list'` surfaces `hasFile` and `mimeType` per receipt. Storage uses Railway's injected `AWS_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` env vars (AWS SDK Generic style); structured receipt data continues to save even when no bucket is configured.
- `src/domain/blob.ts` — thin S3 client wrapper (`uploadFile`, `getSignedDownloadUrl`, `deleteFile`) using `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`

### Changed
- `README.md` — stdio quickstart now says "any MCP-capable environment" (Claude Desktop, Cursor, VS Code, …) rather than Claude Desktop only; added `BOOKIE_DB_DIRECT_URL` to the example config block

### Fixed
- Receipt file storage: assert `fileDeleted` field on `action='delete'`; add test for "bucket not configured" error path (env-var save/restore pattern); correct README MIME type list to include WEBP and HEIC; add same-environment note to `docs/DEPLOYING.md` for Railway Bucket setup

## [0.6.4] — 2026-06-13

### Changed
- `docs/ARCHITECTURE.md` — document OAuth 2.0 endpoints, JWT + static Bearer dual-auth, `POST /` root alias, and `oauth_tokens` table
- `README.md` — expand configuration table to include OAuth env vars; correct Safety section; note `POST /` MCP alias

## [0.6.3] — 2026-06-13

### Fixed
- Move single-owner secret gate from `/authorize` query param to `/token` `client_secret` body field (RFC 6749 compliant); rename env var from `OAUTH_AUTH_SECRET` to `OAUTH_CLIENT_SECRET`

## [0.6.2] — 2026-06-13

### Fixed
- Validate `redirect_uri` against explicit allowlist in `/authorize`; missing or unlisted URIs return 400
- Purge expired refresh tokens from `oauth_tokens` DB table on 60-second cleanup interval
- Add `OAUTH_AUTH_SECRET` single-owner gate on `/authorize`
- OAuth test suite: auth codes, PKCE S256, JWT sign/verify, refresh token rotation and replay detection

## [0.6.1] — 2026-06-13

### Fixed
- Register MCP handler at root `/` so Claude.ai connector URL works without `/mcp` suffix
- Add `PUBLIC_URL`, `JWT_SECRET`, `OAUTH_CLIENT_ID` env vars and Claude.ai connector setup section to `docs/DEPLOYING.md`
- Add `AGENTS.md` to `.gitignore`

## [0.6.0] — 2026-06-13

### Added
- MCP resources: `bookie://accounts` (JSON list of all accounts with current balances) and `bookie://reports/{year}` (annual fiscal snapshot in markdown: Schedule C, Schedule E, and a one-row-per-month summary table).
- MCP prompts: `monthly-close` (guided month-end close workflow), `categorize-uncategorized` (find and categorize entries lacking an income/expense leg), `prepare-tax-summary` (generate + export annual Schedule C and E).
- `manage_rules` gains `action='suggest'`: scans past income/expense categorizations, groups by normalized description, and returns candidate rules for descriptions appearing 2+ times with no existing rule matching them. Rejects `accountId`, `pattern`, `id`, and `priority` when `action='suggest'` (gate 23).

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

[Unreleased]: https://github.com/yuens1002/bookie/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/yuens1002/bookie/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/yuens1002/bookie/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/yuens1002/bookie/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/yuens1002/bookie/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yuens1002/bookie/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yuens1002/bookie/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yuens1002/bookie/releases/tag/v0.1.0
