# /review report — receipt-file-storage

**Branch:** `feat/receipts-railway-bucket-storage` (merged → `main`)
**Commits reviewed:** `3807021` → `5dcde5e` (PR #21 + 3 follow-up commits to main)
**Generated:** 2026-06-14
**Cadence:** lighter (no formal plan doc / ACs); deliverables sourced from conversation plan

## Verdict

**Minor issues** — feature shipped correctly and all tests pass (194/194), but three findings warrant `/retro` attention: (1) env var names were wrong at PR merge and required a post-merge fix commit, a gap in external-service pre-implementation research; (2) the existing `delete` tests were not updated to assert the new `fileDeleted` response field; (3) the README tool description lists only three of five supported MIME types.

---

## De-facto owning roles (no plan doc → fallback)

| Role | Owns |
|------|------|
| `/backend-architect` | schema, `src/domain/blob.ts`, tool handler, docs |
| `/test-engineer` | `test/receipts.test.ts` coverage |

---

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| D1 — `fileKey` + `mimeType` on `Receipt` schema | `prisma/schema.prisma:179–180` | ✓ shipped |
| D2 — `src/domain/blob.ts` (upload / getSignedUrl / delete) | `src/domain/blob.ts:1–46` | ✓ shipped |
| D3 — `attach` gains `fileContent` + `mimeType` + orphan cleanup | `src/tools/receipts.ts:83–153` | ✓ shipped |
| D4 — `get_url` action | `src/tools/receipts.ts:156–163` | ✓ shipped |
| D5 — `delete` also removes blob; `fileDeleted` in response | `src/tools/receipts.ts:166–204` | ✓ shipped |
| D6 — `list` adds `hasFile` + `mimeType` per row | `src/tools/receipts.ts:118–127` | ✓ shipped |
| D7 — `docs/DEPLOYING.md` Railway Bucket setup section | `docs/DEPLOYING.md:81–94` | ✓ shipped |
| D8 — `docs/ARCHITECTURE.md` blob layer note | `docs/ARCHITECTURE.md:77–81` | ✓ shipped |
| D9 — `README.md` tool table + config table | `README.md:62, 106` | ✓ shipped (minor drift — see Docs drift §3) |
| D10 — `docs/TOOLS.md` regenerated | `docs/TOOLS.md` | ✓ shipped |

### Code changes not tied to any deliverable

- **`fix(blob)` commit `5dcde5e`** — renamed env vars from bare names (`ENDPOINT`, `BUCKET`, etc.) to AWS SDK Generic style (`AWS_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`, etc.) after discovering the Railway dashboard injects the latter. Not scope creep — a necessary correctness fix — but it arrived as a post-merge commit rather than being caught pre-implementation. See Finding F1.
- **`docs: broaden stdio quickstart` commit `cf506f2`** — README copy and `BOOKIE_DB_DIRECT_URL` example update. Unrelated to bucket feature; prompted by user feedback. Clean.

---

## ACs ↔ Tests (Gate 3 spot-check)

No formal AC doc; assessed against planned behavior.

| Behavior | Test | Verdict |
|----------|------|---------|
| `attach` no file → `hasFile: false`, `mimeType: null` | `returns hasFile: false and mimeType: null…` | PASS — asserts both fields |
| `attach` `fileContent` without `mimeType` → fail | `fails when fileContent is provided without mimeType` | PASS |
| `attach` `mimeType` without `fileContent` → fail | `fails when mimeType is provided without fileContent` | PASS |
| `list` → `hasFile` + `mimeType` on each row | `includes hasFile and mimeType on each row` | PASS |
| `get_url` missing `receiptId` → fail | `fails when receiptId is missing` | PASS |
| `get_url` receipt has no file → fail | `fails when receipt has no stored file` | PASS |
| `get_url` receipt does not exist → fail | `fails when receipt does not exist` | PASS |
| `delete` → `fileDeleted` field in response | Existing test asserts `del.deleted` only; `fileDeleted` never checked | **WEAK** — new field unasserted |
| `attach` `fileContent`+`mimeType` but no bucket → fail | Not directly tested | **WEAK** — "not configured" error path is reachable in CI (no bucket vars), but the specific error message is never asserted |
| `attach` with file → upload + signed URL returned | No test (requires live bucket) | MISSING — acceptable, cannot mock S3 in current test harness |
| `get_url` → signed URL (with live file) | No test | MISSING — same reason |

---

## Docs drift

1. **`README.md:62` — `manage_receipts` row** lists "JPEG/PNG/PDF" but the Zod enum in `src/tools/receipts.ts:52` supports five types: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`. WEBP and HEIC are omitted from the README description.

2. **`docs/DEPLOYING.md:85`** — step 3 says "select your bookie service" without noting that the service must be in the **same Railway environment** as the bucket, or the dropdown will be empty. This was discovered live during deployment and required debugging.

3. **`docs/ARCHITECTURE.md` layer diagram** — the ASCII diagram (`LLM → Transport → Server → Tools → Domain → Data`) has no mention of the external blob storage path. File uploads exit the Neon layer entirely and go to Tigris/S3; the diagram implies all persistence is through the `src/db/*` layer. Minor — could mislead a future contributor.

---

## Recommendations

1. **Fix `delete` test** — update the existing `deletes a receipt and removes it from list` test to assert `del.fileDeleted === false` (receipt in that test has no file). Confirms the field exists and has the correct value for the no-file case.

2. **Add bucket-not-configured test** — in the `attach` describe block, add a test that passes valid `fileContent` + `mimeType` and asserts `isError` with a message matching `/not configured/i`. Tests run without bucket vars so this path is already reachable; just not asserted.

3. **Correct README MIME type list** — change "JPEG/PNG/PDF" to "JPEG, PNG, WEBP, HEIC, or PDF" to match the Zod enum.

4. **Add same-environment note to DEPLOYING.md** — after step 3, add: "If the Service dropdown is empty, ensure the bucket was created in the same Railway environment as the bookie service."

---

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"Before writing code that reads env vars injected by an external service (Railway Bucket, Resend, Stripe, etc.), open that service's dashboard or docs and confirm the exact variable names the service injects — do not derive them from a search result or docs page summary alone. The Railway Bucket docs listed bare names (`ENDPOINT`, `BUCKET`, …) but the UI injects `AWS_*`-prefixed names under the 'AWS SDK Generic' style; this produced a post-merge fix commit. Treat env var names from external services as unknowns until verified in the actual UI."*
  **Triggered by:** post-merge `fix(blob)` commit `5dcde5e` correcting var names.

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"When a tool's response shape gains new fields (`fileDeleted`, `hasFile`, `mimeType`), update ALL existing tests for ALL actions of that tool — not just the new ones. A new field on `delete` is untested if only the new `get_url` block gets expanded. Grep the response shape for new keys and map each one to an assertion in at least one existing test for each action that returns it."*
  **Triggered by:** `delete` test not asserting `fileDeleted`.

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md` (extends gate 7 — docs follow code)
  **Draft principle:** *"When the tool's input schema uses a Zod enum for accepted values (MIME types, action names, etc.), copy the exact set of values into any README prose that describes that parameter — do not paraphrase or abbreviate. A partial list (`JPEG/PNG/PDF` when the enum has 5 entries) is a docs drift bug that `/review` will flag."*
  **Triggered by:** README `manage_receipts` row omitting WEBP and HEIC.

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md` (extends gate 7 — deploying docs)
  **Draft principle:** *"When documenting external-service connection steps (Railway Bucket, Neon, Resend), include the failure mode for each UI step — not just the success path. 'Select your bookie service' with no note about same-environment requirement sent the user to debug a Railway-specific constraint silently. Add: 'If [X] is empty/missing, ensure [prerequisite].' one line per step."*
  **Triggered by:** Railway Bucket `Add to Service` dropdown being empty (different environment).
