# P5 — Resources & Prompts
Source: `docs/ROADMAP.md` — P5 section
Branch: `feat/p5-resources-prompts`

## Context

P5 adds the remaining MCP surface area: resources (structured data the LLM can read without calling a tool) and prompts (canned workflow starters), plus learned categorization (detect repeated manual categorizations that should be rules).

The server already declares `capabilities: { resources: {}, prompts: {} }` and the MCP SDK exposes `server.resource()`, `server.prompt()`, and `ResourceTemplate`. No schema changes, no new dependencies.

## Design decisions

**`bookie://reports/{year}` content** — returns a combined annual snapshot: rendered Sch C markdown + rendered Sch E markdown + a one-line summary per calendar month (opening balance, net income, cleared status). One URI, full fiscal year picture. Avoids encoding report type in the URI template.

**Learned categorization shape** — `manage_rules` gains a new `action='suggest'` mode (consistent with `import_transactions`/`reconcile` two-step pattern). It queries JournalEntries, groups by normalized description, and returns candidate rules for descriptions with 2+ matching categorizations and no existing rule. User creates rules via the existing `create` action. No auto-create.

## Deliverables

| ID | Deliverable | Kind | Owning role |
|----|-------------|------|-------------|
| D1 | `src/resources.ts` — register `bookie://accounts` (list with balances) + `bookie://reports/{year}` (annual fiscal snapshot) | endpoint | `/backend-architect` |
| D2 | `src/prompts.ts` — register 3 MCP prompts: `monthly-close`, `categorize-uncategorized`, `prepare-tax-summary` | endpoint | `/backend-architect` |
| D3 | `src/tools/rules.ts` — add `action='suggest'` to `manage_rules`: scan for descriptions with 2+ categorizations and no rule | endpoint | `/backend-architect` |
| D4 | `test/resources-prompts.test.ts` — invariants for D1+D2+D3 | test | `/test-engineer` |
| D5 | `README.md` — document new surface (resources, prompts, suggest action); `docs/TOOLS.md` regenerated | doc | `/backend-architect` |

## Prompt content

| Prompt name | Parameters | Content |
|-------------|------------|---------|
| `monthly-close` | `year`, `month` | Walk through: import CSV → categorize uncategorized entries → reconcile → generate report → (optionally) send |
| `categorize-uncategorized` | _(none)_ | Call `query_transactions` for entries without an income/expense leg, present each one, help user categorize |
| `prepare-tax-summary` | `year` | Generate Sch C + Sch E, export as markdown and CSV, optionally send via email |

## Commit schedule

1. `feat(p5): register MCP resources and prompts` — D1 + D2 + D5 (partial)
2. `feat(p5): add suggest action to manage_rules` — D3
3. `test(p5): add invariants for resources, prompts, and rule suggestions` — D4
4. `docs: update README + TOOLS.md for P5 surface` — D5 (final)
