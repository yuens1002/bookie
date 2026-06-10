# Releasing bookie

bookie follows [Semantic Versioning](https://semver.org). Releases are **GitHub Releases** (a tag + notes); bookie is **not published to npm** — it runs from source or the included Docker image against your own Neon Postgres.

## Versioning (0.x line)
- **minor** (`0.Y.0`) — a roadmap-phase increment (a coherent batch of features). Breaking changes are allowed pre-1.0 and called out in the changelog.
- **patch** (`0.y.Z`) — fixes and docs between phases.
- **1.0.0** — cut when the core loop is complete (P0–P3: ledger → import → categorize → reconcile → tax reports) **and** bookie has produced a real reporting cycle on actual books. After 1.0, breaking changes bump major.

## Cadence
Release per roadmap phase, when a coherent increment has merged to `main`. The `[Unreleased]` section of [`docs/CHANGELOG.md`](CHANGELOG.md) accumulates across feature PRs; a release promotes it into a dated version section.

## Process
The maintainer runs the release locally:
1. Bump `version` in `package.json`; promote `[Unreleased]` → `[X.Y.Z] — <date>` in `docs/CHANGELOG.md`; update the compare links.
2. Open a `chore(release): vX.Y.Z` PR and merge it.
3. Tag the merge commit `vX.Y.Z` (annotated) and push it.
4. `gh release create vX.Y.Z` with notes from the changelog section.

## Changelog
`docs/CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com). Every user-facing change is logged under `[Unreleased]` in the PR that makes it, then promoted to a version on release.
