# P4 Plan — Remote Hardening & Delivery

**Source:** `docs/ROADMAP.md` — P4
**Status:** planned
**Target release:** v0.5.0

---

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Rate limiting scope | Per IP, in-memory fixed-window counter. Sufficient for single-instance Railway deploy — distributed rate limiting (Redis) is over-engineered for this use case. Configurable via `RATE_LIMIT_RPM` env var (integer, default 60). Hono middleware on the `/mcp` route only (not `/health`). |
| D2 | Rate limit exceeded response | `429 Too Many Requests` with JSON body `{ error: "rate limit exceeded" }`. No `Retry-After` header (can be added later). |
| D3 | Audit log destination | `stderr` only — Railway captures and persists it; no DB table. Log `{ts, ip, method, toolName}` per `/mcp` POST. `toolName` is extracted from the MCP JSON-RPC body (`params.name`) when present; falls back to `body.method` for non-tool-call requests (e.g. `initialize`). |
| D4 | `send_report` email format | Markdown body only — sending CSV as a raw email body is awkward. Use `export_report` for CSV files; `send_report` is for human-readable delivery. No `format` param. |
| D5 | `send_report` env vars | `RESEND_API_KEY` (required — returns `fail()` if unset at call time) + `RESEND_FROM` (required — the verified sender address configured in Resend). Both read from `process.env` at tool call time so Railway env changes take effect without restart. |
| D6 | `send_report` placement | `src/tools/reports.ts` — same file as `generate_report`/`export_report`, reusing the same private fetch helpers. No new file. |
| D7 | Deploy guide location | `docs/DEPLOYING.md` — committed, public, covers Railway + Neon production-branch + Resend account setup and env var reference. The existing `railway.json` + `Dockerfile` already handle the deploy mechanics; the guide is the human walkthrough. |
| D8 | PR shape | One PR: `feat/p4-hardening-delivery`. All items are small and thematically coupled (hardening + delivery). |

---

## What ships

**`src/transports/http.ts` — two new middlewares:**

- Rate limiting: Hono middleware before the `/mcp` route handler; counts requests per IP in a fixed window; responds 429 when exceeded.
- Audit logging: logs `{ts, ip, method, toolName}` to stderr after auth passes; extracts `toolName` from the MCP JSON-RPC body before handing off to the transport.

**New tool `send_report` in `src/tools/reports.ts`:**

- Same params as `generate_report` except no `format` (always markdown).
- Additional required params: `to` (recipient email address).
- Checks `RESEND_API_KEY` and `RESEND_FROM` at call time; returns `fail()` if either is missing.
- Re-runs the same DB fetch helpers → renders markdown → sends via `new Resend(key).emails.send(...)`.
- Registered in `registerReportTools`.

**New file `docs/DEPLOYING.md`:**

- Prerequisites: Railway account, Neon account, Resend account + verified sender.
- Env vars table: `BOOKIE_DB_URL`, `BOOKIE_DB_DIRECT_URL`, `BOOKIE_API_KEY`, `PORT`, `RESEND_API_KEY`, `RESEND_FROM`, `RATE_LIMIT_RPM` (optional).
- Step-by-step: Railway project setup → connect Neon production branch → set env vars → deploy → smoke-test with `/health`.
- Neon branching: `production` (live ledger) vs `dev/main` (local/tests).

---

## Deliverables

| ID | Deliverable | Kind | Owning role |
|----|-------------|------|-------------|
| D1 | `docs/DEPLOYING.md` — step-by-step Railway + Neon production + Resend setup, env var reference table | job | `/devops` |
| D2 | `src/transports/http.ts` — per-request rate limiting middleware (in-memory fixed-window, IP-keyed, `RATE_LIMIT_RPM` env var, default 60 rpm, 429 on exceed) + audit logging middleware (`{ts, ip, method, toolName}` to stderr per `/mcp` POST) | endpoint | `/backend-architect` |
| D3 | `src/tools/reports.ts` — `send_report` tool: `type`, `year`, optional `month` (monthly-reconciliation only), `to` (email); re-runs report in markdown; sends via Resend; fail-fast on missing env vars | endpoint | `/backend-architect` |
| D4 | `test/send-report.test.ts` — integration tests for `send_report` fail branches (missing `RESEND_API_KEY`, missing `RESEND_FROM`, `type='schedule-c'` with `month`, `type='monthly-reconciliation'` without `month`); D2 manual smoke-test notes | test | `/test-engineer` |

---

## Commit schedule

1. `feat(p4): add rate limiting, audit logging, send_report tool, and deploy guide`
2. PR → Copilot review → merge → `docs/CHANGELOG.md [Unreleased]` entry

---

## Docs updates

- `npm run docs:tools` → regenerate `docs/TOOLS.md` (15 → 16 tools)
- README tool table — add `send_report` row
- `docs/ROADMAP.md` — mark P4 items ✅
- `docs/CHANGELOG.md` — `[Unreleased]` entry

Release: after PR merges, run `/release minor` → v0.5.0.
