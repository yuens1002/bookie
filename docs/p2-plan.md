# P2 Plan — Receipts & Reconciliation

**Source:** `docs/ROADMAP.md` — P2
**Status:** planned
**Target release:** v0.3.0

---

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Receipt attachment model | Both flows via one tool: `split_transaction` → `manage_receipts attach` (new-entry); or attach to existing imported entry (post-hoc). Same `action='attach'`, different timing. |
| D2 | `reconcile` input shape | CSV — same bank statement file and profiles (`signed-amount`, `debit-credit`, `rental-export`) as `import_transactions`. Import creates entries; reconcile later marks them cleared. |
| D3 | PR shape | Two PRs: schema+reconcile first, then receipts+report. |
| D4 | `generate_report` time scope | `year` + `month` params (not arbitrary date range). |
| D5 | `manage_receipts lineItems` input | Structured array from the LLM (tool serializes to JSON internally). |

---

## Increment 1 — Schema + Reconcile

**Branch:** `feat/p2-reconcile`

**What ships:**
- `Posting` gets `cleared Boolean @default(false)` + `statementRef String?`
- `reconcile` tool: two-step preview → commit mirroring `import_transactions`
  - `mode='preview'` — parses statement CSV, matches lines to uncleared payment-leg postings by amount + date ±window, reports three buckets: `matched` / `on-statement-not-in-ledger` / `in-ledger-not-on-statement`. Writes nothing.
  - `mode='commit'` — marks matched postings `cleared=true` + sets `statementRef` (e.g. the bank's row identifier or a content hash)
- Matching logic in `src/domain/reconcile.ts` (pure, deterministic, unit-testable directly)
- Same CSV profiles as `import_transactions` — no new profiles needed

### Deliverables

| ID | Deliverable | Kind | Owning role |
|----|-------------|------|-------------|
| D1 | `prisma/schema.prisma` — `Posting.cleared Boolean @default(false)` + `Posting.statementRef String?`; `npm run db:push` + `prisma generate` | migration | `/backend-architect` |
| D2 | `src/domain/reconcile.ts` — pure match engine: given statement lines + existing payment-leg postings, return matched/unmatched/uncleared buckets by amount + date ±window | job | `/backend-architect` |
| D3 | `src/tools/reconcile.ts` — `reconcile` tool (preview/commit); registered in `src/server.ts`; Zod input schema; `ok()`/`fail()` returns | endpoint | `/backend-architect` |
| D4 | `test/reconcile.test.ts` — integration + domain unit tests: matched posting gets `cleared=true`, already-cleared is idempotent, discrepancy buckets correct, all `fail()` branches covered | test | `/test-engineer` |

### Commit schedule
1. `feat(reconcile): add cleared/statementRef to Posting + reconcile tool`
2. PR → Copilot review → merge → `docs/CHANGELOG.md [Unreleased]` entry

---

## Increment 2 — Receipts + Report

**Branch:** `feat/p2-receipts-report`

**What ships:**
- `manage_receipts` tool: `attach` / `list` / `delete`
  - `attach`: link a receipt to an existing `entryId`; accepts `merchant`, `date`, `total` (dollars), `lineItems` (structured array — serialized to JSON string internally). Works for new-entry flow (call after `split_transaction`) and post-hoc flow (call against an imported entry).
  - `list`: filter by `entryId` or date range
  - `delete`: remove a receipt by id
  - `Receipt` model already exists in schema — **no migration needed**
- `generate_report` tool: first mode `monthly-reconciliation`
  - Params: `type='monthly-reconciliation'`, `year` (int), `month` (1–12), optional `accountId`
  - Output: opening balance, closing balance, categorized spending totals per segment, uncategorized entries (no income/expense leg) flagged, uncleared payment postings flagged as discrepancies
  - Report logic in `src/domain/report.ts` (pure, deterministic)
  - P3 adds `type='schedule-c'` / `type='schedule-e'` modes to the same tool

### Deliverables

| ID | Deliverable | Kind | Owning role |
|----|-------------|------|-------------|
| D5 | `src/tools/receipts.ts` — `manage_receipts` tool (attach/list/delete); registered in `src/server.ts` | endpoint | `/backend-architect` |
| D6 | `src/domain/report.ts` — pure monthly reconciliation logic: balance computation (opening/closing), categorized totals by segment, uncleared + uncategorized flagging | job | `/backend-architect` |
| D7 | `src/tools/reports.ts` — `generate_report` tool (`type='monthly-reconciliation'`, `year`, `month`, optional `accountId`); registered in `src/server.ts` | endpoint | `/backend-architect` |
| D8 | `test/receipts.test.ts` — `manage_receipts` attach/list/delete + all `fail()` branches; `test/report.test.ts` — `generate_report` monthly mode invariants | test | `/test-engineer` |

### Commit schedule
1. `feat(receipts): add manage_receipts tool and generate_report monthly-reconciliation mode`
2. PR → Copilot review → merge → `docs/CHANGELOG.md [Unreleased]` entry

---

## Docs updates (both increments)

Each PR includes:
- `npm run docs:tools` → regenerate `docs/TOOLS.md`
- README tool table — add new tool rows
- `docs/ROADMAP.md` — mark shipped items ✅
- `docs/CHANGELOG.md` — `[Unreleased]` entry

Release: after both PRs merge, run `/release minor` → v0.3.0.
