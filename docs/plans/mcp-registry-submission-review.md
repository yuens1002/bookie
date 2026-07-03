# /review report — MCP Registry submission (mcpName + server.json)

**Branch:** `feat/mcp-registry-submission` (uncommitted, pre-PR)
**Generated:** 2026-07-03
**Iterations to reach verified:** 2 — pass 1 added `mcpName`/`server.json`; pass 2 discovered (via a live `mcp-publisher validate`/`publish` dry run, not simulation) that the registry cross-checks against the *published* npm tarball, forcing a version-pointer fix and a real release plan.

## Structural exception (no in-repo plan)

Lighter cadence (`CLAUDE.md`), no `feature-plan.md`/`ACs.md`. De-facto owning role:

- `/backend-architect` (project-local, `.claude/commands/backend-architect.md`) — owns `package.json`'s `mcpName`, `server.json`, and the npm/registry publish-metadata surface (extends existing gate 7, "docs follow code").
- `/test-engineer` (project-local) — owns `test/server-json.test.ts`.

## Verdict

**Clear, with one real external-system finding already resolved.** Metadata is correct and validated live against the registry API; a genuine cross-system version-drift issue was found and the fix path (real release, not just a local edit) was confirmed necessary — see Finding #1.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| `mcpName` field so the registry can verify package ownership | `package.json:5` — `"mcpName": "io.github.yuens1002/bookie"` | ✓ shipped |
| Registry manifest | `server.json` (new) | ✓ shipped, validated live (`mcp-publisher validate` → ✅) |
| Regression guard: `server.json` ↔ `package.json` stay in sync | `test/server-json.test.ts` | ✓ shipped |
| Changelog entry | `CHANGELOG.md` → `[Unreleased] → Added` | ✓ shipped |

### Code changes not tied to any deliverable
None.

## ACs ↔ Tests (Gate 3 spot-check)

No ACs doc; spot-checked directly.

| Check | Result |
|-------|--------|
| `test/server-json.test.ts` asserts the real invariant, not vacuously | ✓ — reads both JSON files at runtime, compares live values. Verified live: temporarily corrupted `server.json`'s `name` field, reran, got a clean failure; reverted. |
| `server.json` itself is valid per the live registry schema | ✓ — `mcp-publisher validate` against `https://registry.modelcontextprotocol.io` returns `✅ server.json is valid`. |
| No DB/network dependency in the test | ✓ — plain file reads, both files local. |

## Docs drift

None. No README/DEPLOYING.md claims are invalidated — this doesn't change how bookie is installed or run, only adds registry discoverability metadata.

## Findings

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | **The MCP Registry validates a submitted `server.json` against the *actual published npm tarball*, not the local repo.** First `mcp-publisher publish` attempt failed: `NPM package 'bookie-mcp' not found` — because `server.json`/`package.json` were pointed at version `0.8.3`, which was bumped in `package.json` by the prior (tooling-only, no-release) PR but never tagged/published to npm (npm's latest is `0.8.2`). Pointing `server.json` at `0.8.2` fixed that error but surfaced a second, more fundamental one: `NPM package 'bookie-mcp' is missing required 'mcpName' field` — because `0.8.2` was published to npm *before* `mcpName` existed in `package.json` at all, and no currently-published version has it. This isn't fixable by editing `server.json` alone: the registry entry can only validate against a version that (a) exists on npm and (b) has `mcpName` baked into its published `package.json`. Confirmed by re-running `mcp-publisher publish` against both `0.8.3` and `0.8.2` live — both failed for these distinct reasons, not simulated. | Severe (blocks the submission entirely, not just a config nit) | Not fixed by this PR alone — requires a real release (this PR bumps to `0.8.4` with `mcpName` included; a `/release patch` after merge tags `v0.8.4`, which triggers `npm-publish.yml` → publishes `bookie-mcp@0.8.4` to npm with `mcpName` present → only then can `mcp-publisher publish` succeed against `0.8.4`). Confirmed with the human before proceeding, since cutting a release is a more visible action than the metadata change alone — human chose "PR the metadata change, then `/release patch`." Registry `publish` deferred to after that release ships. |

## Recommendations

1. **After this PR merges, run `/release patch`** to tag `v0.8.4` and let CI publish `bookie-mcp@0.8.4` to npm.
2. **After npm confirms `0.8.4` is live** (`npm view bookie-mcp versions` includes it), re-run `mcp-publisher validate` then `mcp-publisher publish` from a clean checkout of `main` — not this branch — since `server.json`'s version already points at `0.8.4`, no further edits should be needed.
3. Once the registry entry succeeds, the visibility-strategy memory's step 2 (MCP directory presence) can move from "PulseMCP recommends registry first" to "registry entry exists" — the manual PulseMCP/mcpservers.org/mcpmarket.com forms are still separately gated behind human go-ahead (posting to external services), per that memory's existing note.

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"When a third-party registry/directory validates a submitted manifest against your package's *published* artifact (not your local repo state), treat 'add the metadata locally' and 'the metadata is live where the validator checks' as two separate, sequential deliverables — not one. Check what the validator actually reads (a live `validate`/dry-run call, not just the manifest schema) before assuming a local edit is sufficient. Here, `mcp-publisher validate` accepted the local `server.json` happily, but `mcp-publisher publish` — which cross-checks the real npm tarball — failed twice for two different reasons a schema-only validation couldn't have caught."*
  **Triggered by:** Finding #1 — schema validation passing gave false confidence; only the live publish attempt against the real registry surfaced the actual blocker.

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"Extends the existing 'paired config values that must stay in sync' pattern (Dockerfile `ENV PORT`/`EXPOSE`): when two files must agree on a cross-referenced identifier for an external system to accept them (e.g. a registry manifest's `name` and the package manifest's ownership-verification field), add the same plain file-read sync test — verified live by deliberately corrupting one side and confirming the test fails, then reverting."*
  **Triggered by:** `test/server-json.test.ts` — same failure shape as the Dockerfile guard, different files.

## Ready for Review

- /review report: `docs/plans/mcp-registry-submission-review.md`

One paragraph: adds `mcpName` to `package.json` and a validated `server.json` for the official MCP Registry, plus a regression test keeping the two files' cross-referenced identifiers in sync (verified live to actually catch drift). A real, live-discovered blocker: the registry validates against the *published* npm package, and no published version has `mcpName` yet — confirmed by two distinct live `publish` failures, not simulated. This PR alone cannot complete the registry submission; it sets up `package.json`/`server.json` at `0.8.4` so that a `/release patch` after merge (human-confirmed next step) publishes the version the registry actually needs. Clear to proceed to `/commit`.
