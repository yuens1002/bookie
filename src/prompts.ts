import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// --- module-scope argument schemas (never constructed inside a handler) ------

const MonthlyCloseArgs = {
  year: z.string().describe("The fiscal year, e.g. '2025'"),
  month: z.string().describe("The month number (1–12), e.g. '3' for March"),
};

const PrepareTaxSummaryArgs = {
  year: z.string().describe("The fiscal year, e.g. '2025'"),
};

// --- prompt registration -----------------------------------------------------

export function registerPrompts(server: McpServer): void {
  // -------------------------------------------------------------------------
  // monthly-close — guided month-end close workflow
  // -------------------------------------------------------------------------
  server.prompt(
    "monthly-close",
    "Walk through a month-end close: import CSV, categorize, reconcile, report, and optionally email.",
    MonthlyCloseArgs,
    async ({ year, month }) => {
      const text = `Let's close out ${year}-${month.padStart(2, "0")} together. Here's the workflow:

**Step 1 — Import the bank/card CSV**
Call \`import_transactions\` with \`mode: "preview"\` first to see what rows will be created, including any auto-categorization suggestions from your rules. Once the preview looks right, call \`import_transactions\` again with \`mode: "commit"\` to post the entries.

**Step 2 — Categorize uncategorized entries**
After import, call \`query_transactions\` for ${year}-${month.padStart(2, "0")} and look for journal entries that have no income or expense posting leg. For each one, decide the correct category account and call \`categorize_transaction\` with the entry id and the target \`accountId\`. If a description repeats and you'd like it auto-categorized in future imports, use \`manage_rules\` with \`action: "create"\` to add a rule.

**Step 3 — Reconcile against the statement**
Once entries are categorized, call \`reconcile\` with \`mode: "preview"\` to match your statement CSV against the ledger and see which postings line up. Then call \`reconcile\` with \`mode: "commit"\` to mark them cleared.

**Step 4 — Generate the monthly report**
Call \`generate_report\` with \`type: "monthly-reconciliation"\`, \`year: ${year}\`, and \`month: ${month}\` to see opening/closing balances, income/expense totals by segment, any remaining uncategorized entries, and uncleared postings.

**Step 5 — (Optional) Email the report**
If you'd like a copy by email, call \`send_report\` with the same parameters plus a \`to\` email address.

Ready? Let's start with step 1 — paste or describe the CSV you'd like to import.`;

      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // categorize-uncategorized — find and categorize entries lacking a category
  // -------------------------------------------------------------------------
  server.prompt(
    "categorize-uncategorized",
    "Find journal entries that have no income or expense leg and walk through categorizing each one.",
    async () => {
      const text = `Let's find and categorize any uncategorized journal entries.

**Step 1 — Find uncategorized entries**
Call \`query_transactions\` to retrieve recent entries. We're looking for entries where none of the postings land on an income or expense account — these are "pass-through" or "uncategorized" entries that only touch asset/liability/equity accounts.

**Step 2 — Review each entry**
For each uncategorized entry, I'll show you the date, description, and amount. You decide:
- Which **category account** it belongs to (use \`manage_accounts\` with \`action: "list"\` to see available income/expense accounts)
- Whether it should be tagged to a **rental property** (use \`manage_properties\` to list properties)

**Step 3 — Categorize**
For each entry, call \`categorize_transaction\` with:
- \`entryId\` — the entry to update
- \`accountId\` — the income or expense account to post to
- (optionally) \`propertyId\` — to tag it to a Schedule E rental property

**Step 4 — Create rules to prevent repeat work**
If the same merchant or description will recur, call \`manage_rules\` with \`action: "create"\` to add an auto-categorization rule so future imports suggest the right category automatically.

Shall I call \`query_transactions\` now to find uncategorized entries? If so, let me know the date range to search (or I'll default to the last 90 days).`;

      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // prepare-tax-summary — generate and export annual tax schedules
  // -------------------------------------------------------------------------
  server.prompt(
    "prepare-tax-summary",
    "Generate Schedule C and Schedule E for the year, export as markdown and CSV, and optionally send by email.",
    PrepareTaxSummaryArgs,
    async ({ year }) => {
      const text = `Let's prepare your ${year} tax summary.

**Step 1 — Generate Schedule C (Sole Proprietor P&L)**
Call \`generate_report\` with \`type: "schedule-c"\` and \`year: ${year}\` to see your business income and expenses grouped by Schedule C tax line.

**Step 2 — Generate Schedule E (Rental Real Estate)**
Call \`generate_report\` with \`type: "schedule-e"\` and \`year: ${year}\` to see rental income and expenses grouped by property and Schedule E tax line.

**Step 3 — Export as markdown**
Call \`export_report\` with \`format: "markdown"\` for each schedule type to get a human-readable version you can paste into a document or share with your accountant.

**Step 4 — Export as CSV**
Call \`export_report\` with \`format: "csv"\` for each schedule type to get a spreadsheet-ready version for further analysis or tax software import.

**Step 5 — (Optional) Email the summaries**
If you'd like to send one or both reports by email, call \`send_report\` with the schedule type, \`year: ${year}\`, and a \`to\` email address.

Ready? I'll start with Step 1. Should I call \`generate_report\` for Schedule C now?`;

      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    },
  );
}
