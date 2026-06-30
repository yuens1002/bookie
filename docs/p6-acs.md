# P6 Acceptance Criteria — Install Automation + GHCR Image Pipeline

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-FN-1 | D1 | `/backend-architect` | `scripts/setup.ts` — absent `.env` produces all required vars | Code review: `scripts/setup.ts` | File writes non-empty values for `BOOKIE_DB_URL`, `BOOKIE_DB_DIRECT_URL`, `BOOKIE_API_KEY`, `JWT_SECRET`, `OAUTH_CLIENT_SECRET` when `.env` is absent | | | |
| AC-FN-2 | D1 | `/backend-architect` | `scripts/setup.ts` — idempotency: existing non-empty values are never overwritten | Code review: `scripts/setup.ts` `buildEnvContent` | When a key already has a non-empty value in the current `.env`, `buildEnvContent` preserves it and does not replace with a newly generated value | | | |
| AC-FN-3 | D1 | `/backend-architect` | `scripts/setup.ts` — missing `neonctl` exits with actionable message | Code review: `scripts/setup.ts` `checkNeonctl` | When `neonctl` is not on PATH, the function throws/exits with a message containing the string `neonctl` and an install instruction | | | |
| AC-FN-4 | D1 | `/backend-architect` | `scripts/setup.ts` — secret format | Code review: `scripts/setup.ts` `generateSecrets` | `BOOKIE_API_KEY` and `JWT_SECRET` are exactly 64 hex characters; `OAUTH_CLIENT_SECRET` is a base64url string of ≥ 32 characters with no `+` or `/` characters | | | |
| AC-FN-5 | D2 | `/backend-architect` | `package.json` — `setup` script entry present | Code review: `package.json` | `scripts.setup` equals `"tsx scripts/setup.ts"` | | | |
| AC-FN-6 | D3 | `/devops` | `.github/workflows/docker-publish.yml` — triggers on version tags and pushes both tags | Code review: `.github/workflows/docker-publish.yml` | Workflow triggers on `push: tags: ['v*.*.*']`; build-push step produces both `ghcr.io/yuens1002/bookie-mcp:latest` and `ghcr.io/yuens1002/bookie-mcp:<semver-tag>` | | | |
| AC-FN-7 | D3 | `/devops` | `.github/workflows/docker-publish.yml` — uses only `GITHUB_TOKEN` for registry auth | Code review: `.github/workflows/docker-publish.yml` | Login step uses `password: ${{ secrets.GITHUB_TOKEN }}` with no hardcoded credentials or additional secrets | | | |
| AC-FN-8 | D4 | `/backend-architect` | `README.md` Quick Start — references `npm run setup` | Code review: `README.md` | Quick Start (local, stdio) section contains `npm run setup` and removes manual `cp .env.example .env` + fill-in steps | | | |
| AC-FN-9 | D4 | `/backend-architect` | `README.md` — GHCR image URL documented | Code review: `README.md` | README references `ghcr.io/yuens1002/bookie-mcp:latest` as the deploy image URL (in Quick Start remote section or Docs table) | | | |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-TST-1 | D5 | `/test-engineer` | `generateSecrets()` — output format invariants | Test run: `npm test` | `scripts/setup.test.ts` asserts `BOOKIE_API_KEY` and `JWT_SECRET` are 64-char hex strings (`/^[0-9a-f]{64}$/`); `OAUTH_CLIENT_SECRET` matches base64url pattern (`/^[A-Za-z0-9_-]+$/`) and length ≥ 32 | | | |
| AC-TST-2 | D5 | `/test-engineer` | `parseConnectionUris(json)` — extracts both postgresql:// URLs from `projects create` JSON | Test run: `npm test` | `scripts/setup.test.ts` passes a fixture matching the `neonctl projects create --output json` shape and asserts both returned URLs begin with `postgresql://` and that the pooled URL host contains `-pooler` | | | |
| AC-TST-3 | D5 | `/test-engineer` | `buildEnvContent(values, existing)` — idempotency: pre-set keys are preserved | Test run: `npm test` | `scripts/setup.test.ts` calls `buildEnvContent` with a non-empty `BOOKIE_DB_URL` in `existing` and asserts the output string retains that exact value unchanged | | | |
| AC-TST-4 | D5 | `/test-engineer` | `checkNeonctl()` — ENOENT → throws with actionable message | Test run: `npm test` | `scripts/setup.test.ts` mocks `execSync` to throw `ENOENT` and asserts `checkNeonctl()` throws an error whose message includes the word "neonctl" | | | |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-REG-1 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | All tests in `src/lib/money.test.ts` and `src/domain/import/parse.test.ts` plus new `scripts/setup.test.ts` pass — 0 failures | | | |
| AC-REG-2 | — | `/backend-architect` | TypeScript compiles clean | Test run: `npm run typecheck` | 0 type errors across all source and script files | | | |
