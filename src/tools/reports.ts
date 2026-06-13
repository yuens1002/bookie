import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../db/client.js";
import { formatMoney } from "../lib/money.js";
import { ok, fail } from "../lib/result.js";
import {
  computeMonthlyReport,
  lastDayOfMonth,
  type ReportPosting,
  type ReportEntry,
} from "../domain/report.js";

function shiftIso(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    "generate_report",
    {
      title: "Generate report",
      description:
        "Generate a financial report for a given period. type='monthly-reconciliation': opening/closing balance for an optional bank/card account, income and expense totals grouped by segment, uncategorized entries (no income/expense leg), and uncleared payment postings. Additional types (schedule-c, schedule-e) will be added in a later phase.",
      inputSchema: {
        type: z
          .enum(["monthly-reconciliation"])
          .describe("Report type. 'monthly-reconciliation' is currently the only supported type."),
        year: z.number().int().min(2000).max(2100).describe("Report year (e.g. 2025)."),
        month: z
          .number()
          .int()
          .min(1)
          .max(12)
          .describe("Report month (1 = January, 12 = December)."),
        accountId: z
          .string()
          .optional()
          .describe(
            "Bank/card account (asset or liability type) for opening and closing balance computation. Omit to skip the balance section. Use manage_accounts → list.",
          ),
      },
    },
    async (args) => {
      // --- validate accountId --------------------------------------------------
      let accountName: string | null = null;
      if (args.accountId) {
        const account = await prisma.account.findUnique({
          where: { id: args.accountId },
          select: { id: true, name: true, type: true },
        });
        if (!account) {
          return fail(`Account "${args.accountId}" does not exist. Use manage_accounts → list.`);
        }
        if (account.type !== "asset" && account.type !== "liability") {
          return fail(
            `Account "${account.name}" is type "${account.type}" — accountId must be a bank or card account (asset or liability) for balance computation.`,
          );
        }
        accountName = account.name;
      }

      const mm = String(args.month).padStart(2, "0");
      const periodStart = `${args.year}-${mm}-01`;
      const periodEnd = lastDayOfMonth(args.year, args.month);
      const dayBeforeMonth = shiftIso(periodStart, -1);

      // --- pre-month balance postings (for opening balance) --------------------
      const preMonthAccountPostings: { amount: number }[] = args.accountId
        ? await prisma.posting.findMany({
            where: {
              accountId: args.accountId,
              entry: { date: { lte: dayBeforeMonth } },
            },
            select: { amount: true },
          })
        : [];

      // --- all postings in the month -------------------------------------------
      const rawMonthPostings = await prisma.posting.findMany({
        where: { entry: { date: { gte: periodStart, lte: periodEnd } } },
        select: {
          id: true,
          amount: true,
          accountId: true,
          cleared: true,
          entry: { select: { id: true, date: true, description: true } },
          account: {
            select: {
              name: true,
              type: true,
              segmentId: true,
              segment: { select: { name: true } },
            },
          },
        },
      });

      const monthPostings: ReportPosting[] = rawMonthPostings.map((p) => ({
        id: p.id,
        amount: p.amount,
        accountId: p.accountId,
        accountType: p.account.type,
        accountName: p.account.name,
        segmentId: p.account.segmentId,
        segmentName: p.account.segment?.name ?? null,
        cleared: p.cleared,
        entryId: p.entry.id,
        entryDate: p.entry.date,
        entryDescription: p.entry.description,
      }));

      // --- all entries in the month (for uncategorized check) ------------------
      const rawEntries = await prisma.journalEntry.findMany({
        where: { date: { gte: periodStart, lte: periodEnd } },
        select: {
          id: true,
          date: true,
          description: true,
          postings: { select: { account: { select: { type: true } } } },
        },
      });

      const monthEntries: ReportEntry[] = rawEntries.map((e) => ({
        id: e.id,
        date: e.date,
        description: e.description,
        postingAccountTypes: e.postings.map((p) => p.account.type),
      }));

      // --- compute report (pure) -----------------------------------------------
      const report = computeMonthlyReport({
        year: args.year,
        month: args.month,
        accountId: args.accountId ?? null,
        accountName,
        preMonthAccountPostings,
        monthPostings,
        monthEntries,
      });

      // --- format output -------------------------------------------------------
      const totalIncomeMinor = report.bySegment.reduce((s, seg) => s + seg.incomeMinor, 0);
      const totalExpensesMinor = report.bySegment.reduce((s, seg) => s + seg.expensesMinor, 0);

      return ok({
        type: args.type,
        year: report.year,
        month: report.month,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        ...(report.accountId !== null
          ? {
              account: { id: report.accountId, name: report.accountName },
              openingBalance: formatMoney(report.openingBalanceMinor!),
              openingBalanceMinor: report.openingBalanceMinor,
              closingBalance: formatMoney(report.closingBalanceMinor!),
              closingBalanceMinor: report.closingBalanceMinor,
            }
          : {}),
        summary: {
          totalIncome: formatMoney(totalIncomeMinor),
          totalIncomeMinor,
          totalExpenses: formatMoney(totalExpensesMinor),
          totalExpensesMinor,
          netMinor: totalIncomeMinor - totalExpensesMinor,
          net: formatMoney(totalIncomeMinor - totalExpensesMinor),
          uncategorizedCount: report.uncategorizedEntries.length,
          unclearedCount: report.unclearedPaymentPostings.length,
        },
        bySegment: report.bySegment.map((s) => ({
          segmentId: s.segmentId,
          segmentName: s.segmentName,
          income: formatMoney(s.incomeMinor),
          incomeMinor: s.incomeMinor,
          expenses: formatMoney(s.expensesMinor),
          expensesMinor: s.expensesMinor,
          net: formatMoney(s.netMinor),
          netMinor: s.netMinor,
          accounts: s.accounts.map((a) => ({
            accountId: a.accountId,
            accountName: a.accountName,
            total: formatMoney(a.totalMinor),
            totalMinor: a.totalMinor,
          })),
        })),
        uncategorizedEntries: report.uncategorizedEntries,
        unclearedPaymentPostings: report.unclearedPaymentPostings.map((p) => ({
          postingId: p.postingId,
          entryId: p.entryId,
          date: p.date,
          description: p.description,
          accountId: p.accountId,
          accountName: p.accountName,
          amount: formatMoney(p.amountMinor),
          amountMinor: p.amountMinor,
        })),
      });
    },
  );
}
