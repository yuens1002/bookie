# P6 — Install Automation + GHCR Image Pipeline
Source: user request (2026-06-30)
Branch: `feat/p6-install-automation`

## Context

bookie's current install story requires manual steps: create a Neon project, copy connection strings, hand-generate secrets, copy `.env.example`, run `db:push`. That's 15+ minutes of friction for the "dev like me" target audience.

P6 closes that gap with two deliverables:

1. **`npm run setup`** — an idempotent CLI script that creates the Neon DB via `neonctl`, generates all secrets via `node:crypto`, writes a fully-populated `.env`, and runs `prisma db push`. After setup the user only needs to copy `BOOKIE_API_KEY` into their MCP host config.

2. **GHCR publish workflow** — a GitHub Actions workflow that builds and pushes `ghcr.io/yuens1002/bookie-mcp:latest` (+ version tag) on every `v*.*.*` release tag. This lets Railway users deploy from image rather than building from source, and gives MCP directory listings a verified image URL.

## Design decisions

**Idempotency:** The setup script reads the current `.env` before writing. Any key that already has a non-empty value is preserved as-is. Re-running setup never stomps existing credentials.

**Neonctl JSON shape:** `neonctl projects create --output json` returns `connection_uris[0].connection_parameters` with both `host` (direct) and `pooler_host` (pooled). We construct both URLs from that single response — no second `connection-string` call needed.

**Secret sizes:**
- `BOOKIE_API_KEY` — `crypto.randomBytes(32).toString("hex")` → 64-char hex
- `JWT_SECRET` — `crypto.randomBytes(32).toString("hex")` → 64-char hex  
- `OAUTH_CLIENT_SECRET` — `crypto.randomBytes(24).toString("base64url")` → 32-char base64url (matches `.env.example` generate comment)

**Testability:** Setup script exports pure helper functions (`parseConnectionUris`, `generateSecrets`, `buildEnvContent`, `checkNeonctl`) so vitest can cover them without mocking the full process. The `main()` orchestrator is the only side-effectful entry point.

**GHCR workflow:** Uses `docker/metadata-action` to produce both `:latest` and `:<tag>` labels from the git tag. `GITHUB_TOKEN` is the only secret — no external credentials needed. Image is publicly readable so Railway's "Deploy from image" works without auth.

**Railway note:** The existing `Dockerfile` and `railway.json` are unchanged. GHCR just gives an alternative deploy path (image vs. GitHub source build).

## Deliverables

| ID | Deliverable | Kind | Owning role |
|----|-------------|------|-------------|
| D1 | `scripts/setup.ts` — idempotent setup: neonctl auth + project create, secret gen, `.env` write, `prisma db push` | job | `/backend-architect` |
| D2 | `package.json` — add `"setup": "tsx scripts/setup.ts"` to scripts | config | `/backend-architect` |
| D3 | `.github/workflows/docker-publish.yml` — build + push to GHCR on `v*.*.*` tag push | job | `/devops` |
| D4 | `README.md` — replace manual Neon setup steps with `npm run setup`; note GHCR image URL | doc | `/backend-architect` |
| D5 | `scripts/setup.test.ts` — unit tests for `parseConnectionUris`, `generateSecrets`, `buildEnvContent`, `checkNeonctl` error path | test | `/test-engineer` |

## Commit schedule

1. `docs: add plan + ACs for p6 install automation` — this file + `docs/p6-acs.md`
2. `feat(setup): add npm run setup with neon + secret generation` — D1 + D2
3. `chore(ci): add ghcr docker publish workflow` — D3
4. `docs(readme): update quick start to use npm run setup` — D4
5. `test(setup): add unit tests for setup helpers` — D5
