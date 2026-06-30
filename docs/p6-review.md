# /review report — p6-install-automation

**Branch:** `feat/p6-install-automation`
**Generated:** 2026-06-30
**Iterations to reach verified:** 1 (one typecheck fix: `noUncheckedIndexedAccess` on array index in `parseConnectionUris`)

## Verdict

**Minor** — all 5 deliverables shipped and all ACs have correct tests, but AC-TST-4's Pass cell names the wrong function (`execSync` vs `spawnSync`) and CONTRIBUTING.md's Setup section still shows the old manual steps without mentioning `npm run setup`. Neither blocks approval; both feed `/retro`.

---

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| D1 | `scripts/setup.ts:1–192` — `checkNeonctl`, `parseConnectionUris`, `generateSecrets`, `parseEnvFile`, `buildEnvContent` exported; `main()` guarded by `process.argv[1]` | ✓ shipped |
| D2 | `package.json:23` — `"setup": "tsx scripts/setup.ts"` | ✓ shipped |
| D3 | `.github/workflows/docker-publish.yml:1–41` — triggers on `v*.*.*` tags, `GITHUB_TOKEN` auth, `docker/metadata-action` produces `:latest` + `:<semver>` | ✓ shipped |
| D4 | `README.md:11–61` — prerequisites updated to neonctl, Quick Start replaced with `npm run setup`, GHCR image URL added to remote section | ✓ shipped |
| D5 | `scripts/setup.test.ts:1–171` — 17 tests covering all 4 exported helpers + `checkNeonctl` happy path | ✓ shipped |

### Code changes not tied to any deliverable

- `docs/p6-plan.md` and `docs/p6-acs.md` — workflow artifacts (plan commit), not scope creep.

---

## ACs ↔ Tests (Gate 3 spot-check)

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|-------------------|-------|
| AC-TST-1 | `scripts/setup.test.ts` | ✓ PASS | Regexes `/^[0-9a-f]{64}$/` and `/^[A-Za-z0-9_-]+$/` are invariants, not literals from seed data |
| AC-TST-2 | `scripts/setup.test.ts` | ✓ PASS | Asserts `direct === connection_uri`, `pooled` contains `-pooler` and doesn't contain the direct host — relation-based, not literal |
| AC-TST-3 | `scripts/setup.test.ts` | ✓ PASS | Idempotency test passes `overrides` simulating `{ ...generated, ...existing }` merge and asserts existing value survives — correctly models the invariant |
| AC-TST-4 | `scripts/setup.test.ts` | ✓ PASS (stale AC text) | Test correctly mocks `spawnSync` and asserts `throws /neonctl/` — **but AC-TST-4 Pass cell says "mocks `execSync`"** when the implementation uses `spawnSync`. The test is right; the AC text is wrong. |

---

## Docs drift

1. **`docs/p6-acs.md` AC-TST-4 Pass cell** (line 22) — says "mocks `execSync` to throw `ENOENT`" but `checkNeonctl` calls `spawnSync`, not `execSync`. The test mocks `spawnSync` correctly. The AC text is stale.
   - Contradicting code: `scripts/setup.ts:35` — `const result = spawnSync("neonctl", ...)`

2. **`CONTRIBUTING.md:21-26`** — Setup section still shows `cp .env.example .env` + manual fill + `npm run db:push` with no mention of `npm run setup`. This audience (contributors) may use non-Neon Postgres, so the manual steps aren't wrong — but a contributor setting up with Neon now has a better path (`npm run setup`) that's invisible here.
   - Contradicting code: `package.json:23` — `"setup": "tsx scripts/setup.ts"` exists and handles the manual steps automatically.

3. **`README.md:7`** — "comfortable with a **15-minute setup**" — with `npm run setup` the setup for a Neon path is closer to 5 minutes. Minor copy staleness, not a correctness issue.

---

## Recommendations

1. **Fix AC-TST-4 Pass cell** — change "mocks `execSync`" to "mocks `spawnSync`" in `docs/p6-acs.md`. One-line edit; can be included in the `/commit` pass.

2. **Add `npm run setup` note to CONTRIBUTING.md** — after the `cp .env.example .env` block, add a single line: _"Or run `npm run setup` to handle Neon project creation, secret generation, and schema push automatically."_ Keeps manual path available for non-Neon contributors while surfacing the automated path.

3. *(Optional)* **Update "15-minute setup" copy in README** — reduce to "5-minute setup" to reflect the actual experience post-`npm run setup`.

---

## Inputs for /retro

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When writing an `AC-TST-*` Pass cell that names a specific function being mocked (e.g. 'mocks `execSync`'), verify the name against the actual code path before finalizing the ACs doc. A mismatch between the AC's function name and the real call site survives Gate 1/2 and Gate 3 — it's caught only by `/review`."*
  **Triggered by:** AC-TST-4 Pass cell named `execSync` but `checkNeonctl` calls `spawnSync`.

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"When adding a new first-class install/setup path (a new `npm run` script, a CLI command), scan docs beyond `README.md` for stale manual steps — particularly `CONTRIBUTING.md`, which has its own Setup section. A new automated path that only appears in README leaves contributors with a worse experience than intended users."*
  **Triggered by:** `CONTRIBUTING.md` Setup section not updated when `npm run setup` was added.
