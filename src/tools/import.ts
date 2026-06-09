import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../db/client.js";
import { newId } from "../lib/id.js";
import { formatMoney } from "../lib/money.js";
import { ok, fail } from "../lib/result.js";
import { isPrismaCode } from "../lib/prisma.js";
import { parseCsv } from "../domain/import/parse.js";
import { listProfiles, PROFILES } from "../domain/import/profiles.js";
import {
  assignExternalIds,
  classifyRows,
  type ExistingPosting,
} from "../domain/import/match.js";
import { matchRule } from "../domain/import/rules.js";
import { loadRuleSpecs } from "./rules.js";

const DEFAULT_WINDOW_DAYS = 4;

const profileNames = listProfiles() as [string, ...string[]];

/** Shift an ISO date string by N days (lexical ISO compares match DB ordering). */
function shiftIso(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function registerImportTools(server: McpServer): void {
  server.registerTool(
    "import_transactions",
    {
      title: "Import transactions from CSV",
      description:
        "Import a bank/card statement (CSV) for one account, as balanced double-entry transactions. Two-step: run with mode='preview' (default) to parse, deduplicate, and flag possible matches — this writes nothing — then review the plan, decide a category account per row, and call again with mode='commit' and `mappings`. The amount sign is handled per profile; posting direction follows the statement (a charge increases a card's balance, a deposit increases a bank balance). Rows are 2-legged (payment + one category); for a line that splits across categories, skip it here and use split_transaction.",
      inputSchema: {
        mode: z
          .enum(["preview", "commit"])
          .default("preview")
          .describe("preview = parse + dedup + flag matches, no writes (default). commit = write the entries named in `mappings`."),
        profile: z
          .enum(profileNames)
          .describe(
            `CSV shape. Available: ${Object.values(PROFILES)
              .map((p) => `'${p.name}' (${p.description})`)
              .join(" | ")}`,
          ),
        csv: z.string().min(1).describe("Raw CSV text of the statement (including the header row)."),
        paymentAccountId: z
          .string()
          .describe("The bank/card account this statement belongs to — the leg every row's payment posts to. Use manage_accounts → list."),
        windowDays: z
          .number()
          .int()
          .min(0)
          .max(31)
          .optional()
          .describe(`Date window (± days) for flagging possible matches against existing entries. Default ${DEFAULT_WINDOW_DAYS}.`),
        mappings: z
          .array(
            z.object({
              index: z.number().int().min(0).describe("0-based row index from the preview"),
              targetAccountId: z.string().describe("Category account for this row (expense for spend, income for a deposit)"),
              propertyId: z.string().optional().describe("Rental property (Schedule E). Use manage_properties → list."),
              skip: z.boolean().optional().describe("Explicitly skip this row"),
            }),
          )
          .optional()
          .describe("Required for mode='commit': one entry per row to import. Rows without a mapping (or with skip=true) are NOT written."),
      },
    },
    async (args) => {
      const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;

      // Shared validation: the payment account must exist.
      const paymentAccount = await prisma.account.findUnique({
        where: { id: args.paymentAccountId },
        select: { id: true, name: true, type: true },
      });
      if (!paymentAccount) {
        return fail("paymentAccountId does not exist. Use manage_accounts → list.");
      }

      // Shared parse.
      let rows;
      try {
        rows = parseCsv(args.csv, args.profile);
      } catch (err) {
        return fail(`CSV parse failed: ${(err as Error).message}`);
      }
      if (rows.length === 0) return fail("No data rows found in the CSV.");

      const externalIds = assignExternalIds(args.paymentAccountId, rows);

      if (args.mode === "preview") {
        const existing = await prisma.journalEntry.findMany({
          where: { externalId: { in: externalIds } },
          select: { externalId: true },
        });
        const existingExternalIds = new Set(existing.map((e) => e.externalId as string));

        // Only postings that could match: same amount as some row, within the
        // date window around the file's span. Avoids scanning the whole account.
        const amounts = [...new Set(rows.map((r) => r.amountMinor))];
        const sortedDates = rows.map((r) => r.date).sort();
        const lo = shiftIso(sortedDates[0]!, -windowDays);
        const hi = shiftIso(sortedDates[sortedDates.length - 1]!, windowDays);
        const postings = await prisma.posting.findMany({
          where: {
            accountId: args.paymentAccountId,
            amount: { in: amounts },
            entry: { date: { gte: lo, lte: hi } },
          },
          select: { amount: true, entry: { select: { id: true, date: true, description: true } } },
        });
        const existingPostings: ExistingPosting[] = postings.map((p) => ({
          amount: p.amount,
          entryId: p.entry.id,
          date: p.entry.date,
          description: p.entry.description,
        }));

        const planned = classifyRows({ rows, externalIds, existingExternalIds, existingPostings, windowDays });
        const ruleSpecs = await loadRuleSpecs();
        const summary = {
          total: planned.length,
          create: planned.filter((r) => r.action === "create").length,
          duplicate: planned.filter((r) => r.action === "duplicate").length,
          possibleMatch: planned.filter((r) => r.action === "possible-match").length,
        };

        return ok({
          mode: "preview",
          note: "Nothing was written. Each row carries a `suggested` rule match when one applies — a categorize suggestion gives the targetAccountId (and propertyId) to use in `mappings`; an exclude suggestion means skip the row. Review, then call again with mode='commit' and `mappings`.",
          profile: args.profile,
          paymentAccount,
          windowDays,
          summary,
          rows: planned.map((r) => {
            const suggested = matchRule(r.description, ruleSpecs);
            return {
              index: r.index,
              date: r.date,
              description: r.description,
              amount: formatMoney(r.amountMinor),
              amountMinor: r.amountMinor,
              direction: r.amountMinor >= 0 ? "in" : "out",
              action: r.action,
              ...(suggested ? { suggested } : {}),
              ...(r.rawCategory ? { categoryHint: r.rawCategory } : {}),
              ...(r.rawProperty ? { propertyHint: r.rawProperty } : {}),
              ...(r.duplicateOf ? { duplicateOf: r.duplicateOf } : {}),
              ...(r.candidates ? { candidates: r.candidates } : {}),
            };
          }),
        });
      }

      // --- commit ---------------------------------------------------------------
      if (!args.mappings || args.mappings.length === 0) {
        return fail("mode='commit' requires `mappings` (one per row to import). Run mode='preview' first.");
      }

      const byIndex = new Map<number, (typeof args.mappings)[number]>();
      for (const m of args.mappings) {
        if (m.index < 0 || m.index >= rows.length) {
          return fail(`mappings index ${m.index} is out of range (file has ${rows.length} rows).`);
        }
        if (m.targetAccountId === args.paymentAccountId) {
          return fail(`Row ${m.index}: targetAccountId must differ from paymentAccountId.`);
        }
        if (byIndex.has(m.index)) {
          return fail(`Duplicate mapping for index ${m.index}. Map each row at most once.`);
        }
        byIndex.set(m.index, m);
      }

      // Validate referenced accounts and properties exist (skip rows excluded).
      const active = args.mappings.filter((m) => !m.skip);
      const targetIds = [...new Set(active.map((m) => m.targetAccountId))];
      if (targetIds.length > 0) {
        const found = await prisma.account.count({ where: { id: { in: targetIds } } });
        if (found !== targetIds.length) {
          return fail("One or more targetAccountId values do not exist. Use manage_accounts → list.");
        }
      }
      const propertyIds = [...new Set(active.map((m) => m.propertyId).filter((p): p is string => !!p))];
      if (propertyIds.length > 0) {
        const found = await prisma.property.count({ where: { id: { in: propertyIds } } });
        if (found !== propertyIds.length) {
          return fail("One or more propertyId values do not exist. Use manage_properties → list.");
        }
      }

      const created: { index: number; entryId: string; amount: string }[] = [];
      const duplicates: number[] = [];
      const skipped: number[] = [];

      for (let i = 0; i < rows.length; i++) {
        const mapping = byIndex.get(i);
        if (!mapping || mapping.skip) {
          skipped.push(i);
          continue;
        }
        const row = rows[i]!;
        const externalId = externalIds[i]!;
        const entryId = newId("je");
        try {
          await prisma.journalEntry.create({
            data: {
              id: entryId,
              date: row.date,
              description: row.description,
              memo: row.rawCategory ?? null,
              source: "import",
              externalId,
              propertyId: mapping.propertyId ?? null,
              postings: {
                create: [
                  // Payment leg = signed amount (+ in / − out); category leg balances it.
                  { id: newId("po"), accountId: args.paymentAccountId, amount: row.amountMinor },
                  { id: newId("po"), accountId: mapping.targetAccountId, amount: -row.amountMinor },
                ],
              },
            },
          });
          created.push({ index: i, entryId, amount: formatMoney(row.amountMinor) });
        } catch (err) {
          if (isPrismaCode(err, "P2002")) {
            duplicates.push(i);
            continue;
          }
          throw err;
        }
      }

      return ok({
        mode: "commit",
        profile: args.profile,
        paymentAccount,
        summary: { created: created.length, duplicates: duplicates.length, skipped: skipped.length },
        created,
        duplicates,
        skipped,
      });
    },
  );
}
