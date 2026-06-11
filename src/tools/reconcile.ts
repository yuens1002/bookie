import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../db/client.js";
import { formatMoney } from "../lib/money.js";
import { ok, fail } from "../lib/result.js";
import { isPrismaCode } from "../lib/prisma.js";
import { parseCsv } from "../domain/import/parse.js";
import { listProfiles, PROFILES } from "../domain/import/profiles.js";
import {
  matchStatementToLedger,
  type LedgerPosting,
  type StatementLine,
} from "../domain/reconcile.js";

const DEFAULT_WINDOW_DAYS = 4;
const profileNames = listProfiles() as [string, ...string[]];

function shiftIso(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Stable, human-readable reference for a matched statement row. */
function statementRef(line: StatementLine): string {
  return `${line.date}|${String(line.amount)}|${String(line.index)}`;
}

export function registerReconcileTools(server: McpServer): void {
  server.registerTool(
    "reconcile",
    {
      title: "Reconcile statement against ledger",
      description:
        "Match a bank/card statement (CSV) against the ledger to mark postings as cleared. Two-step: run with mode='preview' (default) to see matched postings, statement lines missing from the ledger, and uncleared ledger postings absent from the statement — writes nothing. Call again with mode='commit' to persist the matches (mark cleared=true). Uses the same CSV profiles as import_transactions. Idempotent: already-cleared postings are flagged but not re-written.",
      inputSchema: {
        mode: z
          .enum(["preview", "commit"])
          .default("preview")
          .describe(
            "preview = match and report discrepancies, no writes (default). commit = mark matched postings cleared.",
          ),
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
          .describe(
            "The bank/card account this statement belongs to — the account each row posts to. Use manage_accounts → list.",
          ),
        windowDays: z
          .number()
          .int()
          .min(0)
          .max(31)
          .optional()
          .describe(
            `Date window (± days) for matching statement lines to ledger postings. Default ${DEFAULT_WINDOW_DAYS}.`,
          ),
      },
    },
    async (args) => {
      const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;

      // --- shared validation ---------------------------------------------------
      const paymentAccount = await prisma.account.findUnique({
        where: { id: args.paymentAccountId },
        select: { id: true, name: true, type: true },
      });
      if (!paymentAccount) {
        return fail("paymentAccountId does not exist. Use manage_accounts → list.");
      }
      if (paymentAccount.type !== "asset" && paymentAccount.type !== "liability") {
        return fail(
          `paymentAccountId must be a bank or card account (type asset or liability); got type "${paymentAccount.type}".`,
        );
      }

      let rows;
      try {
        rows = parseCsv(args.csv, args.profile);
      } catch (err) {
        return fail(`CSV parse failed: ${(err as Error).message}`);
      }
      if (rows.length === 0) return fail("No data rows found in the CSV.");

      // --- scoped ledger query -------------------------------------------------
      // Bounded by the statement's date span ± windowDays. We do NOT filter by
      // amount here: unlike import_transactions (which only needs possible-match
      // candidates), reconcile must return ALL uncleared postings in the range
      // for the inLedgerNotOnStatement discrepancy bucket — even those with
      // amounts absent from the statement.
      const sortedDates = rows.map((r) => r.date).sort();
      const lo = shiftIso(sortedDates[0]!, -windowDays);
      const hi = shiftIso(sortedDates[sortedDates.length - 1]!, windowDays);

      const rawPostings = await prisma.posting.findMany({
        where: {
          accountId: args.paymentAccountId,
          entry: { date: { gte: lo, lte: hi } },
        },
        select: {
          id: true,
          amount: true,
          cleared: true,
          entry: { select: { id: true, date: true, description: true } },
        },
        orderBy: { entry: { date: "asc" } },
      });

      const ledgerPostings: LedgerPosting[] = rawPostings.map((p) => ({
        id: p.id,
        amount: p.amount,
        entryId: p.entry.id,
        date: p.entry.date,
        description: p.entry.description,
        cleared: p.cleared,
      }));

      const statementLines: StatementLine[] = rows.map((r) => ({
        index: r.index,
        date: r.date,
        description: r.description,
        amount: r.amountMinor,
      }));

      const result = matchStatementToLedger({ statementLines, ledgerPostings, windowDays });

      // --- preview -------------------------------------------------------------
      if (args.mode === "preview") {
        return ok({
          mode: "preview",
          note: "Nothing was written. Review the buckets and call again with mode='commit' to clear matched postings.",
          paymentAccount,
          windowDays,
          summary: {
            statementLines: rows.length,
            matched: result.matched.length,
            onStatementNotInLedger: result.onStatementNotInLedger.length,
            inLedgerNotOnStatement: result.inLedgerNotOnStatement.length,
          },
          matched: result.matched.map((m) => ({
            statementIndex: m.statementIndex,
            statementDate: m.statementDate,
            statementDescription: m.statementDescription,
            statementAmount: formatMoney(m.statementAmount),
            statementAmountMinor: m.statementAmount,
            postingId: m.postingId,
            entryId: m.entryId,
            alreadyCleared: m.alreadyCleared,
          })),
          onStatementNotInLedger: result.onStatementNotInLedger.map((l) => ({
            statementIndex: l.index,
            date: l.date,
            description: l.description,
            amount: formatMoney(l.amount),
            amountMinor: l.amount,
          })),
          inLedgerNotOnStatement: result.inLedgerNotOnStatement.map((p) => ({
            postingId: p.id,
            entryId: p.entryId,
            date: p.date,
            description: p.description,
            amount: formatMoney(p.amount),
            amountMinor: p.amount,
          })),
        });
      }

      // --- commit --------------------------------------------------------------
      const toWrite = result.matched.filter((m) => !m.alreadyCleared);

      if (toWrite.length > 0) {
        try {
          await prisma.$transaction(
            toWrite.map((m) =>
              prisma.posting.update({
                where: { id: m.postingId },
                data: {
                  cleared: true,
                  // statementLines[i].index === i always (parseCsv assigns row position as index)
                  statementRef: statementRef(statementLines[m.statementIndex]!),
                },
              }),
            ),
          );
        } catch (err) {
          if (isPrismaCode(err, "P2025")) {
            return fail(
              "One or more matched postings were deleted before the reconcile could complete.",
            );
          }
          throw err;
        }
      }

      return ok({
        mode: "commit",
        paymentAccount,
        summary: {
          cleared: toWrite.length,
          alreadyCleared: result.matched.filter((m) => m.alreadyCleared).length,
          onStatementNotInLedger: result.onStatementNotInLedger.length,
          inLedgerNotOnStatement: result.inLedgerNotOnStatement.length,
        },
        cleared: toWrite.map((m) => ({
          statementIndex: m.statementIndex,
          statementDate: m.statementDate,
          statementDescription: m.statementDescription,
          statementAmount: formatMoney(m.statementAmount),
          statementAmountMinor: m.statementAmount,
          postingId: m.postingId,
          entryId: m.entryId,
        })),
        alreadyCleared: result.matched
          .filter((m) => m.alreadyCleared)
          .map((m) => ({
            statementIndex: m.statementIndex,
            postingId: m.postingId,
            entryId: m.entryId,
          })),
        onStatementNotInLedger: result.onStatementNotInLedger.map((l) => ({
          statementIndex: l.index,
          date: l.date,
          description: l.description,
          amount: formatMoney(l.amount),
          amountMinor: l.amount,
        })),
        inLedgerNotOnStatement: result.inLedgerNotOnStatement.map((p) => ({
          postingId: p.id,
          entryId: p.entryId,
          date: p.date,
          description: p.description,
          amount: formatMoney(p.amount),
          amountMinor: p.amount,
        })),
      });
    },
  );
}
