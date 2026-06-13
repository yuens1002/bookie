# /review report — P5 resources & prompts

**Branch:** `feat/p5-resources-prompts` (merged as PR #14)
**Generated:** 2026-06-13
**Iterations to reach verified:** 1 (6 Copilot comments addressed, all resolved before merge)

## Verdict

**Clear — minor findings only.** Two small issues worth a `/retro` lesson (DRY violation on `MONTH_NAMES`, time-fragile test seed date); neither is load-bearing. Proceed to release.

---

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| D1 — `src/resources.ts` — 2 MCP resources | `src/resources.ts` (145 lines) — `bookie://accounts` + `bookie://reports/{year}` | ✓ shipped |
| D2 — `src/prompts.ts` — 3 MCP prompts | `src/prompts.ts` (117 lines) — `monthly-close`, `categorize-uncategorized`, `prepare-tax-summary` | ✓ shipped |
| D3 — `src/tools/rules.ts` — `action='suggest'` | `src/tools/rules.ts` lines 121–186 — full suggest branch with gate-23 rejections + 24-month window | ✓ shipped |
| D4 — `test/resources-prompts.test.ts` | 307 lines, 19 tests — resources, prompts, and suggest coverage | ✓ shipped |
| D5 — README + TOOLS.md | README: Resources + Prompts sections added; manage_rules row updated; `docs/TOOLS.md` regenerated | ✓ shipped |

### Code changes not tied to any deliverable

`src/tools/reports.ts` — 5 previously-private functions promoted to exported (`fetchMonthlyData`, `fetchScheduleCData`, `fetchScheduleEData`, `renderScheduleCMarkdown`, `renderScheduleEMarkdown`). These are consumed by D1 (`src/resources.ts`). Not scope creep; a necessary refactor backing D1 that should have been listed as a D1 sub-task. Noted for future plan authoring.

---

## Tests ↔ Invariants (Gate 3 spot-check)

| Test | File | Asserts invariant? | Notes |
|------|------|--------------------|-------|
| `bookie://accounts` — shape | `test/resources-prompts.test.ts:133` | ✓ | Asserts `id`, `name`, `type`, `balance`, `balanceMinor` fields present; checks test-seeded accounts appear by ID — data-driven, not literal |
| `bookie://reports/{year}` — structure | `test/resources-prompts.test.ts:159` | ✓ | Asserts markdown MIME type, "Schedule C" / "Schedule E" headings, all 12 month names in the table — structural invariants |
| `monthly-close` — content | `test/resources-prompts.test.ts:192` | ✓ | Asserts "import" and "reconcile" appear, year is interpolated — verifies the workflow steps are present |
| `categorize-uncategorized` — content | `test/resources-prompts.test.ts:208` | ✓ (weak) | Asserts `query_transactions` and `categorize_transaction` appear. Does NOT assert `targetAccountId` (the corrected param name Copilot caught) — would have passed even with the bug. Acceptable for prose content, but worth noting. |
| `suggest` — includes 2+ occurrences | `test/resources-prompts.test.ts:249` | ✓ | Seeds 2 matching entries with a unique prefix; asserts the normalized description appears with correct `accountId` and `occurrences >= 2`. Real data-driven invariant. |
| `suggest` — excludes singletons | `test/resources-prompts.test.ts:260` | ✓ | Seeds 1-occurrence entry; asserts it is absent from suggestions. Boundary case. |
| `suggest` — excludes rule-covered | `test/resources-prompts.test.ts:275` | ✓ | Creates a covering rule, then asserts the description is excluded. Tests the dedup logic. |
| Gate-23 rejections (×4) | `test/resources-prompts.test.ts:288` | ✓ | Tests `accountId`, `pattern`, `id`, `priority` each trigger `isError + /does not accept/`. Solid. |

---

## Docs drift

**None critical.** CHANGELOG updated, README updated, TOOLS.md regenerated. `docs/p5-plan.md` committed and consistent with what shipped.

---

## Findings

### F1 — `MONTH_NAMES` duplicated (minor, DRY violation) — ✅ resolved in fix/p5-retro-cleanups

`src/resources.ts:15` and `src/tools/reports.ts:232` each declared the same `const MONTH_NAMES = ["January", ...]` array. When the five rendering helpers were exported from `reports.ts`, `MONTH_NAMES` was not exported alongside them. `src/resources.ts` re-declared it rather than importing it.

**Impact:** Low — both arrays are identical. If a month name is ever corrected (unlikely), one location might be missed.
**Fixed by:** Exporting `MONTH_NAMES` from `src/tools/reports.ts` and removing the re-declaration from `src/resources.ts` (PR #15 / fix/p5-retro-cleanups).

### F2 — Suggest test seed dates would fall outside the 24-month window by ~Jan 2028 (minor, test fragility) — ✅ resolved in fix/p5-retro-cleanups

`test/resources-prompts.test.ts:78` seeded entries with `date: "2025-01-0${i + 1}"`. The `suggest` action's query filters `entry: { date: { gte: cutoffStr } }` where `cutoffStr` is 24 months before runtime. By January 2028 the cutoff reaches 2026-01 — data seeded at 2025-01 would fall outside it.

**Impact:** Test would have broken ~Jan 2028 without code change.
**Fixed by:** Seed dates updated to `2026-01-0${i + 1}`, which remains within the 24-month window through January 2028 (PR #15 / fix/p5-retro-cleanups).

---

## Recommendations

1. ~~**Fix F1 (DRY on MONTH_NAMES)**~~ — ✅ resolved in PR #15: `MONTH_NAMES` exported from `reports.ts`, re-declaration removed from `resources.ts`.
2. ~~**Fix F2 (test seed date)**~~ — ✅ resolved in PR #15: seed dates updated to `2026-01-0N`.
3. **Future plan authoring** — when a deliverable requires exporting previously-private functions from another module, make that an explicit sub-task or note in the plan (e.g., "D1 requires exporting 5 private helpers from `reports.ts`"). This prevents it showing up as an unlisted code change in `/review`.

---

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"When a new module needs a constant that already exists in a module it imports (e.g., `MONTH_NAMES` in `reports.ts`), export it from the source rather than re-declaring it in the consumer. A re-declaration is a DRY violation that creates divergence risk. Pattern: add `export` to the existing declaration; the consumer uses `import { MONTH_NAMES } from '…/tools/reports.js'`. Apply the pre-commit duplication audit (from `/engineering-base`) to constants, not just functions."*
  **Triggered by:** F1 — `MONTH_NAMES` declared independently in `src/resources.ts` and `src/tools/reports.ts`.

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"When writing tests that cover a time-windowed query (e.g., 'last N months'), verify that the seeded date is durably within the window. Hardcoded historical dates (e.g., `2025-01-01`) are within the window at time of writing but fall outside as the cutoff advances. Rule: seed dates should be no more than 6 months before the time of writing, or use a relative offset from 'today' if the implementation allows it. Check: if the seeded date + N months < today + 12 months (i.e., the seed will expire within the next year), update the seed date."*
  **Triggered by:** F2 — `test/resources-prompts.test.ts` seeds 2025-01 entries for a 24-month window; the window expires ~Jan 2027.
