# Contributing to bookie

Thanks for looking! A bit of honesty up front so we don't waste each other's time:

**bookie is built primarily for its author's own personal and business bookkeeping**, released under MIT so others can read it, run it, learn from it, or fork it. Contributions are welcome, but scope is driven by real needs and the [roadmap](docs/ROADMAP.md) — not by feature-completeness against a hypothetical accounting product. If you want something the project doesn't, a fork is a totally legitimate (and encouraged) outcome.

That framing shapes the bar: **correctness is non-negotiable; generality beyond real needs is not.** Small, legible, single-user-first changes land easily. Speculative abstraction, multi-tenant machinery, and config knobs for users who don't exist do not.

## What bookie is

An MCP server (no UI) for **double-entry bookkeeping**. The host LLM (Claude/GPT) is the interface; bookie owns the ledger, money math, deterministic rules, and reports. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Prerequisites

- **Node 24+**
- A **Postgres** database. The project uses [Neon](https://neon.tech); any Postgres works. Don't develop against your real ledger — use a separate database or a Neon **branch**.

## Setup

```bash
git clone <your-fork>
cd bookie
npm install                  # also runs `prisma generate`
cp .env.example .env         # fill in BOOKIE_DB_URL + BOOKIE_DB_DIRECT_URL
npm run db:push              # apply the schema
npm run dev                  # stdio transport; seeds the default chart on first run
```

Run the HTTP transport instead with `npm run dev:http` (serves `POST /mcp`, `GET /health`). Explore tools interactively with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Tests

```bash
npm test           # Vitest, run once
npm run test:watch # watch mode
```

- `src/lib/money.test.ts` — pure unit tests (no DB) for the integer-cent money helpers.
- `test/ledger.test.ts` — integration tests that drive the MCP tools end-to-end and assert the double-entry invariant. **These need a database**: they read `BOOKIE_DB_URL` from `.env`, create throwaway accounts/entries, and clean up after themselves. Point it at a disposable branch — never production.

## Conventions (please follow)

These are enforced in review:

1. **Money is integer minor units (cents).** Never floats. Convert only at the edges via `src/lib/money.ts`.
2. **Every transaction is balanced double-entry** — postings sum to zero. New write paths create entries via balanced postings, never an unbalanced row.
3. **Layering.** Deterministic logic lives in `src/domain/*`; tool handlers stay thin. The server never OCRs images — tools take structured fields the client LLM extracted.
4. **Schema changes** go in `prisma/schema.prisma`, then `npm run db:push` (+ `prisma generate`).
5. **Tool design.** One file per tool group under `src/tools/`. Zod input schemas with `.describe()` on non-obvious fields — the schema *is* the user manual. After changing tools, run `npm run docs:tools` to regenerate `docs/TOOLS.md` (don't hand-edit it).
6. **Both transports stay equal in capability** — differences belong in `buildServer()`, not in a transport.
7. **No secrets in git.** Connection strings live in `.env` (gitignored) and deploy env vars.

Before opening a PR:

```bash
npm run typecheck && npm run build && npm test
```

## Commits & PRs

- **[Conventional Commits](https://www.conventionalcommits.org/)** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Keep PRs small and focused. Update `CHANGELOG.md` (Unreleased) and, if scope changes, `docs/ROADMAP.md`.
- Describe *why*, not just *what*. If it's user-facing, note how it shows up through the LLM.

## License

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
