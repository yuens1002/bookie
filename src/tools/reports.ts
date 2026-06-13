import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Resend } from "resend";
import { prisma } from "../db/client.js";
import { formatMoney } from "../lib/money.js";
import { ok, fail } from "../lib/result.js";
import {
  computeMonthlyReport,
  lastDayOfMonth,
  type ReportPosting,
  type ReportEntry,
  type MonthlyReportResult,
} from "../domain/report.js";
import {
  computeScheduleC,
  computeScheduleE,
  type TaxPosting,
  type ScheduleCResult,
  type ScheduleEResult,
} from "../domain/tax.js";

// --- module-scope Zod schemas -----------------------------------------------

const ReportTypeSchema = z.enum(["monthly-reconciliation", "schedule-c", "schedule-e"]);
const ReportFormatSchema = z.enum(["markdown", "csv"]);

// --- utilities ---------------------------------------------------------------

function shiftIso(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// --- data fetchers -----------------------------------------------------------

type MonthlyData = { result: MonthlyReportResult; accountName: string | null };

export async function fetchMonthlyData(
  year: number,
  month: number,
  accountId: string | undefined,
): Promise<{ ok: true; data: MonthlyData } | { ok: false; error: string }> {
  let accountName: string | null = null;
  if (accountId) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, type: true },
    });
    if (!account) {
      return {
        ok: false,
        error: `Account "${accountId}" does not exist. Use manage_accounts → list.`,
      };
    }
    if (account.type !== "asset" && account.type !== "liability") {
      return {
        ok: false,
        error: `Account "${account.name}" is type "${account.type}" — accountId must be a bank or card account (asset or liability) for balance computation.`,
      };
    }
    accountName = account.name;
  }

  const mm = String(month).padStart(2, "0");
  const periodStart = `${year}-${mm}-01`;
  const periodEnd = lastDayOfMonth(year, month);
  const dayBeforeMonth = shiftIso(periodStart, -1);

  const preMonthAccountPostings: { amount: number }[] = accountId
    ? await prisma.posting.findMany({
        where: { accountId, entry: { date: { lte: dayBeforeMonth } } },
        select: { amount: true },
      })
    : [];

  const rawMonthPostings = await prisma.posting.findMany({
    where: { entry: { date: { gte: periodStart, lte: periodEnd } } },
    orderBy: [{ entry: { date: "asc" } }, { id: "asc" }],
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

  const rawEntries = await prisma.journalEntry.findMany({
    where: { date: { gte: periodStart, lte: periodEnd } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
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

  const result = computeMonthlyReport({
    year,
    month,
    accountId: accountId ?? null,
    accountName,
    preMonthAccountPostings,
    monthPostings,
    monthEntries,
  });

  return { ok: true, data: { result, accountName } };
}

export async function fetchScheduleCData(year: number): Promise<ScheduleCResult> {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const rawPostings = await prisma.posting.findMany({
    where: {
      entry: { date: { gte: yearStart, lte: yearEnd } },
      account: {
        type: { in: ["income", "expense"] },
        segment: { taxSchedule: "C" },
      },
    },
    orderBy: [{ entry: { date: "asc" } }, { id: "asc" }],
    select: {
      id: true,
      amount: true,
      accountId: true,
      account: { select: { name: true, type: true, taxLine: true } },
      entry: { select: { id: true, date: true } },
    },
  });

  const postings: TaxPosting[] = rawPostings.map((p) => ({
    id: p.id,
    amount: p.amount,
    accountId: p.accountId,
    accountType: p.account.type,
    accountName: p.account.name,
    taxLine: p.account.taxLine,
    entryId: p.entry.id,
    entryDate: p.entry.date,
    propertyId: null, // Schedule C has no property dimension
    propertyName: null,
  }));

  return computeScheduleC(postings, year);
}

export async function fetchScheduleEData(year: number): Promise<ScheduleEResult> {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const rawPostings = await prisma.posting.findMany({
    where: {
      entry: { date: { gte: yearStart, lte: yearEnd } },
      account: {
        type: { in: ["income", "expense"] },
        segment: { taxSchedule: "E" },
      },
    },
    orderBy: [{ entry: { date: "asc" } }, { id: "asc" }],
    select: {
      id: true,
      amount: true,
      accountId: true,
      account: { select: { name: true, type: true, taxLine: true } },
      entry: {
        select: {
          id: true,
          date: true,
          propertyId: true,
          property: { select: { name: true } },
        },
      },
    },
  });

  const postings: TaxPosting[] = rawPostings.map((p) => ({
    id: p.id,
    amount: p.amount,
    accountId: p.accountId,
    accountType: p.account.type,
    accountName: p.account.name,
    taxLine: p.account.taxLine,
    entryId: p.entry.id,
    entryDate: p.entry.date,
    propertyId: p.entry.propertyId,
    propertyName: p.entry.property?.name ?? null,
  }));

  return computeScheduleE(postings, year);
}

// --- renderers ---------------------------------------------------------------

/** RFC 4180–safe CSV cell: wraps in double-quotes and escapes embedded quotes by doubling. */
function csvEsc(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function renderMonthlyMarkdown(result: MonthlyReportResult): string {
  const lines: string[] = [
    `# Monthly Reconciliation — ${MONTH_NAMES[result.month - 1]} ${result.year}`,
    `Period: ${result.periodStart} to ${result.periodEnd}`,
    "",
  ];
  if (result.accountId !== null) {
    lines.push("## Account Balance");
    lines.push(`Opening: ${formatMoney(result.openingBalanceMinor!)}`);
    lines.push(`Closing: ${formatMoney(result.closingBalanceMinor!)}`);
    lines.push("");
  }
  if (result.bySegment.length > 0) {
    lines.push("## Income & Expenses by Segment");
    for (const seg of result.bySegment) {
      lines.push(`### ${seg.segmentName ?? "(No segment)"}`);
      lines.push(`  Income:   ${formatMoney(seg.incomeMinor)}`);
      lines.push(`  Expenses: ${formatMoney(seg.expensesMinor)}`);
      lines.push(`  Net:      ${formatMoney(seg.netMinor)}`);
    }
    const totalIncome = result.bySegment.reduce((s, seg) => s + seg.incomeMinor, 0);
    const totalExpenses = result.bySegment.reduce((s, seg) => s + seg.expensesMinor, 0);
    lines.push("");
    lines.push(`**Total Income: ${formatMoney(totalIncome)}**`);
    lines.push(`**Total Expenses: ${formatMoney(totalExpenses)}**`);
    lines.push(`**Net: ${formatMoney(totalIncome - totalExpenses)}**`);
    lines.push("");
  }
  if (result.uncategorizedEntries.length > 0) {
    lines.push(`## Uncategorized Entries (${result.uncategorizedEntries.length})`);
    for (const e of result.uncategorizedEntries) {
      lines.push(`- ${e.date}: ${e.description}`);
    }
    lines.push("");
  }
  if (result.unclearedPaymentPostings.length > 0) {
    lines.push(`## Uncleared Postings (${result.unclearedPaymentPostings.length})`);
    for (const p of result.unclearedPaymentPostings) {
      lines.push(`- ${p.date}: ${p.description} | ${p.accountName} | ${formatMoney(p.amountMinor)}`);
    }
  }
  return lines.join("\n");
}

function renderMonthlyCsv(result: MonthlyReportResult): string {
  const rows: string[] = ["segment,incomeMinor,income,expensesMinor,expenses,netMinor,net"];
  for (const seg of result.bySegment) {
    rows.push(
      [
        csvEsc(seg.segmentName ?? ""),
        seg.incomeMinor,
        csvEsc(formatMoney(seg.incomeMinor)),
        seg.expensesMinor,
        csvEsc(formatMoney(seg.expensesMinor)),
        seg.netMinor,
        csvEsc(formatMoney(seg.netMinor)),
      ].join(","),
    );
  }
  return rows.join("\n");
}

export function renderScheduleCMarkdown(result: ScheduleCResult): string {
  const lines: string[] = [`# Schedule C — Sole Proprietor P&L (${result.year})`, ""];
  lines.push("## Income");
  if (result.incomeLines.length === 0) {
    lines.push("  (none)");
  } else {
    for (const l of result.incomeLines) {
      lines.push(`  ${l.taxLine}: ${formatMoney(l.totalMinor)}`);
    }
    lines.push(`  **Total Income: ${formatMoney(result.totalIncomeMinor)}**`);
  }
  lines.push("");
  lines.push("## Expenses");
  if (result.expenseLines.length === 0) {
    lines.push("  (none)");
  } else {
    for (const l of result.expenseLines) {
      lines.push(`  ${l.taxLine}: ${formatMoney(l.totalMinor)}`);
    }
    lines.push(`  **Total Expenses: ${formatMoney(result.totalExpensesMinor)}**`);
  }
  lines.push("");
  lines.push(`## Net Profit / (Loss): ${formatMoney(result.netMinor)}`);
  return lines.join("\n");
}

function renderScheduleCCsv(result: ScheduleCResult): string {
  const rows: string[] = ["type,taxLine,accountId,accountName,amountMinor,amount"];
  for (const l of result.incomeLines) {
    for (const a of l.accounts) {
      rows.push(
        ["income", csvEsc(l.taxLine), a.accountId, csvEsc(a.accountName), a.totalMinor, csvEsc(formatMoney(a.totalMinor))].join(","),
      );
    }
  }
  for (const l of result.expenseLines) {
    for (const a of l.accounts) {
      rows.push(
        ["expense", csvEsc(l.taxLine), a.accountId, csvEsc(a.accountName), a.totalMinor, csvEsc(formatMoney(a.totalMinor))].join(","),
      );
    }
  }
  return rows.join("\n");
}

export function renderScheduleEMarkdown(result: ScheduleEResult): string {
  const lines: string[] = [`# Schedule E — Rental Real Estate (${result.year})`, ""];
  for (const prop of result.properties) {
    lines.push(`## ${prop.propertyName}`);
    if (prop.incomeLines.length > 0) {
      lines.push("  **Income:**");
      for (const l of prop.incomeLines) {
        lines.push(`    ${l.taxLine}: ${formatMoney(l.totalMinor)}`);
      }
    }
    if (prop.expenseLines.length > 0) {
      lines.push("  **Expenses:**");
      for (const l of prop.expenseLines) {
        lines.push(`    ${l.taxLine}: ${formatMoney(l.totalMinor)}`);
      }
    }
    lines.push(`  Net: ${formatMoney(prop.netMinor)}`);
    lines.push("");
  }
  lines.push(`**Total Net: ${formatMoney(result.totalNetMinor)}**`);
  return lines.join("\n");
}

function renderScheduleECsv(result: ScheduleEResult): string {
  const rows: string[] = [
    "propertyId,propertyName,type,taxLine,accountId,accountName,amountMinor,amount",
  ];
  for (const prop of result.properties) {
    for (const l of prop.incomeLines) {
      for (const a of l.accounts) {
        rows.push(
          [
            prop.propertyId ?? "",
            csvEsc(prop.propertyName),
            "income",
            csvEsc(l.taxLine),
            a.accountId,
            csvEsc(a.accountName),
            a.totalMinor,
            csvEsc(formatMoney(a.totalMinor)),
          ].join(","),
        );
      }
    }
    for (const l of prop.expenseLines) {
      for (const a of l.accounts) {
        rows.push(
          [
            prop.propertyId ?? "",
            csvEsc(prop.propertyName),
            "expense",
            csvEsc(l.taxLine),
            a.accountId,
            csvEsc(a.accountName),
            a.totalMinor,
            csvEsc(formatMoney(a.totalMinor)),
          ].join(","),
        );
      }
    }
  }
  return rows.join("\n");
}

// --- output formatters -------------------------------------------------------

function formatScheduleCOutput(result: ScheduleCResult, type: string) {
  return {
    type,
    year: result.year,
    incomeLines: result.incomeLines.map((l) => ({
      taxLine: l.taxLine,
      total: formatMoney(l.totalMinor),
      totalMinor: l.totalMinor,
      accounts: l.accounts.map((a) => ({
        accountId: a.accountId,
        accountName: a.accountName,
        total: formatMoney(a.totalMinor),
        totalMinor: a.totalMinor,
      })),
    })),
    expenseLines: result.expenseLines.map((l) => ({
      taxLine: l.taxLine,
      total: formatMoney(l.totalMinor),
      totalMinor: l.totalMinor,
      accounts: l.accounts.map((a) => ({
        accountId: a.accountId,
        accountName: a.accountName,
        total: formatMoney(a.totalMinor),
        totalMinor: a.totalMinor,
      })),
    })),
    summary: {
      totalIncome: formatMoney(result.totalIncomeMinor),
      totalIncomeMinor: result.totalIncomeMinor,
      totalExpenses: formatMoney(result.totalExpensesMinor),
      totalExpensesMinor: result.totalExpensesMinor,
      net: formatMoney(result.netMinor),
      netMinor: result.netMinor,
    },
  };
}

function formatScheduleEOutput(result: ScheduleEResult, type: string) {
  return {
    type,
    year: result.year,
    properties: result.properties.map((prop) => ({
      propertyId: prop.propertyId,
      propertyName: prop.propertyName,
      incomeLines: prop.incomeLines.map((l) => ({
        taxLine: l.taxLine,
        total: formatMoney(l.totalMinor),
        totalMinor: l.totalMinor,
        accounts: l.accounts.map((a) => ({
          accountId: a.accountId,
          accountName: a.accountName,
          total: formatMoney(a.totalMinor),
          totalMinor: a.totalMinor,
        })),
      })),
      expenseLines: prop.expenseLines.map((l) => ({
        taxLine: l.taxLine,
        total: formatMoney(l.totalMinor),
        totalMinor: l.totalMinor,
        accounts: l.accounts.map((a) => ({
          accountId: a.accountId,
          accountName: a.accountName,
          total: formatMoney(a.totalMinor),
          totalMinor: a.totalMinor,
        })),
      })),
      totalIncome: formatMoney(prop.totalIncomeMinor),
      totalIncomeMinor: prop.totalIncomeMinor,
      totalExpenses: formatMoney(prop.totalExpensesMinor),
      totalExpensesMinor: prop.totalExpensesMinor,
      net: formatMoney(prop.netMinor),
      netMinor: prop.netMinor,
    })),
    totalNet: formatMoney(result.totalNetMinor),
    totalNetMinor: result.totalNetMinor,
  };
}

// --- helpers -----------------------------------------------------------------

function reportSubject(type: string, year: number, month?: number): string {
  if (type === "monthly-reconciliation" && month != null) {
    return `Bookie: ${MONTH_NAMES[month - 1]} ${year} Monthly Reconciliation`;
  }
  if (type === "schedule-c") return `Bookie: ${year} Schedule C`;
  return `Bookie: ${year} Schedule E`;
}

// --- tool registration -------------------------------------------------------

export function registerReportTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // generate_report
  // -------------------------------------------------------------------------
  server.registerTool(
    "generate_report",
    {
      title: "Generate report",
      description:
        "Generate a financial report. type='monthly-reconciliation': opening/closing balance for an optional bank/card account, income/expense totals by segment, uncategorized entries, and uncleared postings — requires year + month. type='schedule-c': fiscal-year P&L for sole-proprietor segments (taxSchedule=C) grouped by Schedule C tax line — requires year only. type='schedule-e': fiscal-year rental P&L for rental segments (taxSchedule=E) grouped by property then Schedule E tax line — requires year only.",
      inputSchema: {
        type: ReportTypeSchema.describe("Report type."),
        year: z.number().int().min(2000).max(2100).describe("Report year (e.g. 2025)."),
        month: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe(
            "Report month (1–12). Required for monthly-reconciliation; omit for schedule-c and schedule-e (fiscal year covers Jan–Dec).",
          ),
        accountId: z
          .string()
          .optional()
          .describe(
            "Bank/card account ID (asset or liability type) for opening/closing balance in monthly-reconciliation. Omit for tax report types or to skip the balance section.",
          ),
      },
    },
    async (args) => {
      if (args.type === "monthly-reconciliation" && args.month == null) {
        return fail("month is required for type='monthly-reconciliation'.");
      }
      if ((args.type === "schedule-c" || args.type === "schedule-e") && args.month != null) {
        return fail(
          `month must not be supplied for type='${args.type}' — tax reports cover the full fiscal year (Jan–Dec).`,
        );
      }
      if ((args.type === "schedule-c" || args.type === "schedule-e") && args.accountId) {
        return fail(
          `accountId is not applicable for type='${args.type}' — only monthly-reconciliation uses it for balance computation.`,
        );
      }

      if (args.type === "monthly-reconciliation") {
        const fetched = await fetchMonthlyData(args.year, args.month!, args.accountId);
        if (!fetched.ok) return fail(fetched.error);
        const { result, accountName } = fetched.data;
        const totalIncomeMinor = result.bySegment.reduce((s, seg) => s + seg.incomeMinor, 0);
        const totalExpensesMinor = result.bySegment.reduce((s, seg) => s + seg.expensesMinor, 0);
        return ok({
          type: args.type,
          year: result.year,
          month: result.month,
          periodStart: result.periodStart,
          periodEnd: result.periodEnd,
          ...(result.accountId !== null
            ? {
                account: { id: result.accountId, name: accountName },
                openingBalance: formatMoney(result.openingBalanceMinor!),
                openingBalanceMinor: result.openingBalanceMinor,
                closingBalance: formatMoney(result.closingBalanceMinor!),
                closingBalanceMinor: result.closingBalanceMinor,
              }
            : {}),
          summary: {
            totalIncome: formatMoney(totalIncomeMinor),
            totalIncomeMinor,
            totalExpenses: formatMoney(totalExpensesMinor),
            totalExpensesMinor,
            net: formatMoney(totalIncomeMinor - totalExpensesMinor),
            netMinor: totalIncomeMinor - totalExpensesMinor,
            uncategorizedCount: result.uncategorizedEntries.length,
            unclearedCount: result.unclearedPaymentPostings.length,
          },
          bySegment: result.bySegment.map((s) => ({
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
          uncategorizedEntries: result.uncategorizedEntries,
          unclearedPaymentPostings: result.unclearedPaymentPostings.map((p) => ({
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
      }

      if (args.type === "schedule-c") {
        const result = await fetchScheduleCData(args.year);
        return ok(formatScheduleCOutput(result, args.type));
      }

      // schedule-e
      const result = await fetchScheduleEData(args.year);
      return ok(formatScheduleEOutput(result, args.type));
    },
  );

  // -------------------------------------------------------------------------
  // export_report
  // -------------------------------------------------------------------------
  server.registerTool(
    "export_report",
    {
      title: "Export report",
      description:
        "Run a report and render it as markdown or CSV. Accepts the same parameters as generate_report plus a format. Markdown is human-readable; CSV is suitable for spreadsheet import. The report data is fetched fresh — no need to call generate_report first.",
      inputSchema: {
        type: ReportTypeSchema.describe("Report type."),
        year: z.number().int().min(2000).max(2100).describe("Report year (e.g. 2025)."),
        month: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe(
            "Report month (1–12). Required for monthly-reconciliation; omit for schedule-c and schedule-e.",
          ),
        format: ReportFormatSchema.describe(
          "Output format: 'markdown' (human-readable) or 'csv' (spreadsheet-ready).",
        ),
        accountId: z
          .string()
          .optional()
          .describe(
            "Bank/card account ID for balance section in monthly-reconciliation reports. Omit for tax report types.",
          ),
      },
    },
    async (args) => {
      if (args.type === "monthly-reconciliation" && args.month == null) {
        return fail("month is required for type='monthly-reconciliation'.");
      }
      if ((args.type === "schedule-c" || args.type === "schedule-e") && args.month != null) {
        return fail(
          `month must not be supplied for type='${args.type}' — tax reports cover the full fiscal year (Jan–Dec).`,
        );
      }
      if ((args.type === "schedule-c" || args.type === "schedule-e") && args.accountId) {
        return fail(
          `accountId is not applicable for type='${args.type}' — only monthly-reconciliation uses it for balance computation.`,
        );
      }

      if (args.type === "monthly-reconciliation") {
        const fetched = await fetchMonthlyData(args.year, args.month!, args.accountId);
        if (!fetched.ok) return fail(fetched.error);
        const { result } = fetched.data;
        const rendered =
          args.format === "markdown" ? renderMonthlyMarkdown(result) : renderMonthlyCsv(result);
        return ok({
          type: args.type,
          year: result.year,
          month: result.month,
          format: args.format,
          output: rendered,
        });
      }

      if (args.type === "schedule-c") {
        const result = await fetchScheduleCData(args.year);
        const rendered =
          args.format === "markdown"
            ? renderScheduleCMarkdown(result)
            : renderScheduleCCsv(result);
        return ok({ type: args.type, year: result.year, format: args.format, output: rendered });
      }

      // schedule-e
      const result = await fetchScheduleEData(args.year);
      const rendered =
        args.format === "markdown"
          ? renderScheduleEMarkdown(result)
          : renderScheduleECsv(result);
      return ok({ type: args.type, year: result.year, format: args.format, output: rendered });
    },
  );

  // -------------------------------------------------------------------------
  // send_report
  // -------------------------------------------------------------------------
  server.registerTool(
    "send_report",
    {
      title: "Send report by email",
      description:
        "Run a report and email it via Resend. Same parameters as generate_report plus a recipient address. The report is rendered as markdown and sent as the email body. Requires RESEND_API_KEY and RESEND_FROM env vars.",
      inputSchema: {
        type: ReportTypeSchema.describe("Report type."),
        year: z.number().int().min(2000).max(2100).describe("Report year (e.g. 2025)."),
        month: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe(
            "Report month (1–12). Required for monthly-reconciliation; omit for schedule-c and schedule-e.",
          ),
        accountId: z
          .string()
          .optional()
          .describe(
            "Bank/card account ID for balance section in monthly-reconciliation. Omit for tax report types.",
          ),
        to: z.string().email().describe("Recipient email address."),
        subject: z
          .string()
          .optional()
          .describe(
            "Email subject line. Defaults to a generated subject based on report type and period.",
          ),
      },
    },
    async (args) => {
      // Type-scoped parameter validation (gate 23).
      if (args.type === "monthly-reconciliation" && args.month == null) {
        return fail("month is required for type='monthly-reconciliation'.");
      }
      if ((args.type === "schedule-c" || args.type === "schedule-e") && args.month != null) {
        return fail(
          `month must not be supplied for type='${args.type}' — tax reports cover the full fiscal year (Jan–Dec).`,
        );
      }
      if ((args.type === "schedule-c" || args.type === "schedule-e") && args.accountId) {
        return fail(
          `accountId is not applicable for type='${args.type}' — only monthly-reconciliation uses it for balance computation.`,
        );
      }

      // Env vars checked at call time so Railway changes take effect without restart.
      const apiKey = process.env.RESEND_API_KEY;
      const from = process.env.RESEND_FROM;
      if (!apiKey) return fail("RESEND_API_KEY is not set — add it to Railway Variables or .env.");
      if (!from) return fail("RESEND_FROM is not set — add a verified sender address to Railway Variables or .env.");

      // Fetch and render as markdown.
      let markdown: string;
      if (args.type === "monthly-reconciliation") {
        const fetched = await fetchMonthlyData(args.year, args.month!, args.accountId);
        if (!fetched.ok) return fail(fetched.error);
        markdown = renderMonthlyMarkdown(fetched.data.result);
      } else if (args.type === "schedule-c") {
        const result = await fetchScheduleCData(args.year);
        markdown = renderScheduleCMarkdown(result);
      } else {
        const result = await fetchScheduleEData(args.year);
        markdown = renderScheduleEMarkdown(result);
      }

      const subject = args.subject ?? reportSubject(args.type, args.year, args.month);
      const resend = new Resend(apiKey);
      try {
        const { error } = await resend.emails.send({ from, to: args.to, subject, text: markdown });
        if (error) return fail(`Resend error: ${error.message}`);
      } catch (err) {
        return fail(`Resend send failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      return ok({ sent: true, to: args.to, subject });
    },
  );
}
