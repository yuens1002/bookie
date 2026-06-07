# Roadmap

Phased delivery. Each phase is shippable on its own. Status: ✅ done · 🚧 in progress · ⬜ planned.

## P0 — Ledger foundation 🚧
- ✅ Dual transport (stdio + Streamable HTTP) from one entry point
- ✅ Neon Postgres via Prisma + seeded US sole-prop chart of accounts (auto-seed on first run)
- ✅ Double-entry core: `manage_accounts`, `add_transaction`, `query_transactions`, `account_balances`
- ✅ Auto-generated tool manual (`docs:tools`)
- ✅ Vitest suite — money helpers (unit) + double-entry tools (integration)

## P1 — Import & categorize 🚧
- ✅ Segment model (`manage_segments`) — per-venture P&L + tax form (Sch C/E/none), extensible; income/expense accounts carry a segment + `taxLine`, banking stays segment-neutral
- ✅ Property dimension: `Property` model, `manage_properties`, `propertyId` on entries (units not tracked)
- ✅ `delete_transaction` (correct mistakes / remove duplicate imports)
- ✅ `split_transaction` — one entry, one payment leg + N category legs (a receipt splitting across categories/entities; the payment leg is what a statement shows and reconciliation matches)
- ✅ `import_transactions` — parse bank CSV with shape profiles (`signed-amount`, `debit-credit`, `rental-export`; RFC-4180 via `csv-parse`); **preview → confirm** (`mode='preview'`/`'commit'`) before writing
- ✅ Import **match-or-create**: preview flags a statement line whose amount matches an existing payment-leg posting (± date window) so receipt-first entries aren't double-posted; unflagged rows create on confirm
- ✅ Import dedup via `external_id` content hash (idempotent re-import; same-file duplicate lines kept distinct)
- 🚧 Map pre-categorized exports (e.g. rental export) → accounts + property — parser surfaces category/property *hints*; auto-mapping to accounts via rules is the next item
- ⬜ Auto-categorization `rules` + `categorize_transaction` (apply/override; personal vs business)

## P2 — Receipts & reconciliation ⬜
- ⬜ Receipt capture: client LLM extracts line items → `split_transaction` (per-category legs) + attach `Receipt` (full itemization in `lineItems`)
- ⬜ `cleared` marker on the payment posting (+ `statementRef`) so matched entries are tracked
- ⬜ `reconcile` tool — per account, match statement lines ↔ payment-leg postings (amount + date ± window); report matched / in-ledger-not-on-statement / on-statement-not-in-ledger + balance check
- ⬜ `generate_report` → monthly reconciliation summary (opening/closing balance, categorized totals, uncategorized flagged, discrepancies)

## P3 — Tax & export ⬜
- ⬜ `generate_report` → fiscal-year tax summary: **Schedule C** (sole-prop P&L by line) and **Schedule E** (per-property rental income/expense by line)
- ⬜ `export_report` — markdown / CSV

## P4 — Remote hardening & delivery ⬜
- ⬜ Railway deploy guide + Neon production-branch wiring
- ⬜ Per-request rate limiting and audit logging on HTTP transport
- ⬜ `send_report` — email via Resend

## P5 — Resources & prompts ⬜
- ⬜ MCP resources: `bookie://accounts`, `bookie://reports/{year}`
- ⬜ MCP prompts: "monthly close", "categorize uncategorized", "prepare tax summary"
- ⬜ Learned categorization (promote repeated manual categorizations to rules)

## Later / maybe
- Multi-currency, attachments/blob storage for receipt images, Prisma Migrate (versioned migrations) to replace `db push`, multi-entity isolation for HTTP multi-tenant use.
