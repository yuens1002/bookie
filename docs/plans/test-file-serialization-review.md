# /review report — test file serialization

**Branch:** `fix/test-file-serialization`
**Generated:** 2026-08-07
**Iterations to reach verified:** 1

## Verdict

Clear — proceed to human review. A one-line vitest config change plus the two docs that describe it. No plan doc (lighter cadence, single-file fix); de-facto owning role is `/test-engineer`.

## Structural exception — no in-repo plan

This is a patch on the lighter cadence, so Step 0's role discovery falls back to the de-facto owner: **`/test-engineer`** (test infrastructure config). `/backend-architect` is a secondary reader only — the production-side observation below is theirs to act on if it is ever acted on.

## Deliverables ↔ Code

| Deliverable (implied) | Implementation | Status |
|---|---|---|
| D1 — serialize test files so no file's `afterAll` can run during another file's query | `vitest.config.ts:38-49` | ✓ shipped |
| D2 — record the tradeoff where a future reader will hit it | `vitest.config.ts:38-48` (comment), `CONTRIBUTING.md:49`, `CHANGELOG.md` `[Unreleased] → Fixed` | ✓ shipped |
| D3 — per-PR version bump | `package.json`, `package-lock.json` 0.8.13 → 0.8.14 | ✓ shipped |

### Code changes not tied to any deliverable

None. No source file under `src/` is touched.

## ACs ↔ Tests

No `AC-TST-*` rows — this change alters how the existing suite is scheduled, not what it asserts. The honest coverage statement:

| Claim | Evidence | Strength |
|---|---|---|
| Suite still green under serialization | `npm test` — 18 files, 267 tests, 0 failures, 40.03s | ✓ direct |
| Wall-time cost is ~30s | measured both ways on the same machine: 9.57s parallel → 40.03s serial | ✓ direct |
| The race can no longer occur | structural, not empirical — see below | ⚠ argued, not demonstrated |

**On the third row.** The failure this fixes surfaced roughly once in many runs; v0.8.13's CHANGELOG records that three clean re-runs could not reproduce it. So a green suite after the change is worth nothing as evidence — green was already the normal outcome. The claim rests on the schedule instead: vitest runs each file's `beforeAll` → tests → `afterAll` to completion before starting the next file, so at the moment `report.test.ts` calls `generate_report` there is no other file with an `afterAll` in flight, and the interleaving that produced `Inconsistent query result: Field entry is required to return data, got null` has no window to open in. Anyone reading the PR should hold it to that standard and not to a passing run.

Two preconditions were checked, since `fileParallelism: false` only serializes *files*:

- `grep -rn "\.concurrent\|sequence" test/ vitest.config.ts` → no matches. Nothing opts into intra-file concurrency, so file-level serialization is sufficient.
- `isolate: false` was deliberately **not** added to claw back wall time. The reason was initially assumed and then checked, and the assumption was wrong, so it is worth stating precisely. The expectation was that a shared module registry would let the first file's `prisma.$disconnect()` in `afterAll` kill the client for every file after it. `npx vitest run --no-isolate` actually fails earlier and for a different reason: 17 of 18 files die in setup with `BOOKIE_TEST_DB_URL addresses the same database as BOOKIE_DB_URL — refusing to run`. Sharing one module registry means `test/setup.ts`'s `process.env.BOOKIE_DB_URL = testUrl` outlives the file that made it, so the next file's setup sees the substitution already applied and the same-database guard trips on its own handiwork. The `$disconnect()` theory is untested — the setup failure is upstream of it, so that path never executes. The guard behaving this way is correct fail-closed behavior, not a bug; it simply isn't re-entrant, and nothing needs it to be.

## Docs drift

| Location | Status |
|---|---|
| `CONTRIBUTING.md:37-55` (Tests) | Updated — states the ~40s runtime, why, and the condition for re-enabling parallelism. A contributor who hits a 4× slower suite should not have to read `vitest.config.ts` to find out it is deliberate. |
| `CLAUDE.md:58`, `AGENTS.md:57` | No drift — both list `npm test` as a command, make no timing or isolation claim. |
| `docs/oauth-review.md:70` | No drift — historical record of a different, already-fixed failure. |
| `docs/ROADMAP.md:10` | No drift — describes suite scope, not scheduling. |
| `README.md` | No drift — does not describe the test suite. |

## Recommendations

1. **None blocking.** Merge as-is.
2. **Observed, deliberately out of scope:** the same interleaving is reachable in production. `prisma.posting.findMany()` in `src/tools/reports.ts` includes a required `entry` relation, and Prisma resolves that as a second query — so a `delete_transaction` landing between the two would produce the identical error against a real ledger, not just in tests. Single-user and LLM-driven, so the window is small and nobody has hit it. Folding a `reports.ts` change into a test-isolation PR would blur what this change is; if it is worth fixing it is worth its own PR, and that is a judgment call about a hypothetical second concurrent caller — exactly the YAGNI case `CLAUDE.md`'s ethos section describes.

## Inputs for /retro

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When a fix targets a rare, non-reproducible failure, do not report a passing suite as verification — it was already passing most of the time. State the structural argument for why the failure mode is now unreachable, and label the claim as argued rather than demonstrated. A green run on a flaky bug is a null result, and presenting it as a pass is the specific way this class of fix gets mis-trusted."*
  **Triggered by:** this change — the race behind v0.8.13's `Inconsistent query result` error is unreproducible on demand, so `npm test` passing after the fix proves nothing.

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle (refines Critical Rule 3, "Tests must not depend on execution order or shared state"):** *"Rule 3 has two remedies with very different costs: make each test own its data, or serialize execution so shared data can't be contended. Serialization is a scheduling workaround, not isolation — it leaves the tests order-dependent and merely removes the concurrency. When taking it, say so in the config comment, record the wall-time cost measured both ways, and name the condition under which the real fix becomes necessary (here: adding CI, or a second person running the suite)."*
  **Triggered by:** `fileParallelism: false` satisfies Rule 3's *effect* while violating its *letter*; the baseline currently offers no guidance on choosing between the two remedies.

- **Route:** cross-cutting → `CLAUDE.md` process notes
  **Draft note:** *"Measure before and after when a change trades wall time for correctness; carry the real numbers into the CHANGELOG. The 10s → 45s figure quoted for this change from a prior session was a guess that happened to be close — 9.6s → 40.0s measured. Quoting a remembered number as if it were measured is the failure mode, independent of whether it turns out right."*
  **Triggered by:** the estimate predated any measurement of the serial run.

- **Route:** `/engineering-base` → `~/.claude/commands/engineering-base.md`
  **Draft principle:** *"A causal claim about why an alternative was rejected is an assertion, not a rationale, until it is run. Before writing 'X would break because Y' into a PR body, doc, or code comment, spend the command that checks it — the cost is usually one test run, and a wrong mechanism written down confidently is worse than no explanation, because it stops the next person from looking."*
  **Triggered by:** `isolate: false` was rejected in the first draft of this report and the PR body on the stated grounds that `prisma.$disconnect()` would leak across files. `npx vitest run --no-isolate` took 10s and showed the real failure is `test/setup.ts`'s same-database guard tripping on its own env mutation — a different mechanism entirely, and the `$disconnect()` path never even executes. The claim had already been written into two artifacts before it was checked.
