# P3 Plan — Tax & Export

**Source:** `docs/ROADMAP.md` — P3
**Status:** planned
**Target release:** v0.4.0

---

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Tax report time scope | `year` only (Jan 1–Dec 31). `month` is **rejected** (not silently ignored) for `type='schedule-c'` and `type='schedule-e'` — supplying it returns a `fail()`. |
| D2 | Null `taxLine` accounts | Income/expense accounts where `taxLine = null` are grouped into an `"Unclassified"` bucket in both Schedule C and Schedule E outputs. This surfaces accounts the user hasn't tagged yet. |
| D3 | Schedule E entries without `propertyId` | Postings on Sch E segment accounts whose parent entry has no `propertyId` are grouped into an `"Unassigned"` property bucket (not "Unassigned property"). This flags income/expense that hasn't been attributed to a property. |
| D4 | `export_report` input shape | Re-runs the same DB query internally rather than accepting the `generate_report` JSON blob as input. Keeps the tool interface small and eliminates a large JSON-paste step. |
| D5 | `export_report` CSV shape | One row per account line within each group. Schedule C: `type,taxLine,accountId,accountName,amountMinor,amount`. Schedule E: `propertyId,propertyName,type,taxLine,accountId,accountName,amountMinor,amount`. Monthly-reconciliation: one row per segment — `segment,incomeMinor,income,expensesMinor,expenses,netMinor,net`. All string cells use RFC 4180 quoting (embedded `"` doubled). |
| D6 | PR shape | One PR: `feat/p3-tax-export`. Both changes are small and semantically coupled. |

---

## What ships

**`generate_report` — two new types:**

- `type='schedule-c'` — fiscal-year P&L for sole-prop segments (`taxSchedule = C`). Groups income accounts by `taxLine`, expense accounts by `taxLine`. Params: `year`. No `month`.
- `type='schedule-e'` — fiscal-year rental P&L (`taxSchedule = E`). Groups by property, then by `taxLine` within each property. Params: `year`. No `month`.

**New tool `export_report`:**

- Accepts same params as `generate_report` plus `format: 'markdown' | 'csv'`.
- Re-runs the report query and returns a rendered string ready to paste, email, or save.
- Registered alongside `generate_report` in `src/tools/reports.ts`.

**New domain file `src/domain/tax.ts`:**

- `computeScheduleC(postings: TaxPosting[], year: number): ScheduleCResult` — pure, no DB.
- `computeScheduleE(postings: TaxPosting[], year: number): ScheduleEResult` — pure, no DB. Groups by `propertyId` within the postings.
- Uses own `TaxPosting` interface (extends the ledger fields with `taxLine`, `propertyId`, `propertyName`); does not reuse `ReportPosting`.

---

## Deliverables

| ID | Deliverable | Kind | Owning role |
|----|-------------|------|-------------|
| D1 | `src/domain/tax.ts` — `computeScheduleC`: groups Sch C income/expense postings by `taxLine`; null taxLine → `"Unclassified"` bucket; returns `{ incomeLine[], expenseLine[], totalIncomeMinor, totalExpensesMinor, netMinor }` | job | `/backend-architect` |
| D2 | `src/domain/tax.ts` (same file) — `computeScheduleE`: groups Sch E postings by property name, then by `taxLine` within each property; no-property postings → `"Unassigned property"` bucket; returns `{ properties[{ propertyId, propertyName, lines[], netMinor }], totalNetMinor }` | job | `/backend-architect` |
| D3 | `src/tools/reports.ts` — extend `generate_report`: add `'schedule-c'` and `'schedule-e'` to the `type` enum; validate `month` is absent for tax types; fetch full-year postings; wire `computeScheduleC` / `computeScheduleE`; format and return structured JSON | endpoint | `/backend-architect` |
| D4 | `src/tools/reports.ts` — `export_report` tool: `type`, `year`, optional `month` (monthly-reconciliation only), `format: 'markdown' \| 'csv'`; re-runs report query internally; returns rendered string; registered in `registerReportTools` | endpoint | `/backend-architect` |
| D5 | `test/tax.test.ts` — domain unit tests for `computeScheduleC` + `computeScheduleE`; integration tests for `generate_report` schedule-c and schedule-e modes via MCP client; `export_report` markdown + CSV output + all `fail()` branches | test | `/test-engineer` |

---

## Commit schedule

1. `feat(tax): add Schedule C/E report modes and export_report tool`
2. PR → Copilot review → merge → `docs/CHANGELOG.md [Unreleased]` entry

---

## Docs updates

- `npm run docs:tools` → regenerate `docs/TOOLS.md`
- `docs/ROADMAP.md` — mark P3 items ✅
- `docs/CHANGELOG.md` — `[Unreleased]` entry

Release: after PR merges, run `/release minor` → v0.4.0.
