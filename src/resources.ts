import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "./db/client.js";
import { formatMoney } from "./lib/money.js";
import {
  fetchScheduleCData,
  fetchScheduleEData,
  fetchMonthlyData,
  renderScheduleCMarkdown,
  renderScheduleEMarkdown,
} from "./tools/reports.js";

// --- helpers -----------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// --- resource registration ---------------------------------------------------

export function registerResources(server: McpServer): void {
  // -------------------------------------------------------------------------
  // bookie://accounts — static resource: all accounts with current balances
  // -------------------------------------------------------------------------
  server.resource(
    "accounts",
    "bookie://accounts",
    { description: "All ledger accounts with their current balances." },
    async (uri) => {
      const accounts = await prisma.account.findMany({
        where: { archived: false },
        include: { segment: { select: { name: true } } },
        orderBy: [{ type: "asc" }, { name: "asc" }],
      });

      const grouped = await prisma.posting.groupBy({
        by: ["accountId"],
        _sum: { amount: true },
      });
      const totals = new Map(grouped.map((g) => [g.accountId, g._sum.amount ?? 0]));

      const balances = accounts.map((a) => {
        const minor = totals.get(a.id) ?? 0;
        return {
          id: a.id,
          name: a.name,
          type: a.type,
          segmentId: a.segmentId,
          segment: a.segment?.name ?? null,
          balance: formatMoney(minor),
          balanceMinor: minor,
        };
      });

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(balances, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // bookie://reports/{year} — template resource: annual fiscal snapshot
  // -------------------------------------------------------------------------
  server.resource(
    "annual-report",
    new ResourceTemplate("bookie://reports/{year}", { list: undefined }),
    { description: "Annual fiscal snapshot for the given year: Schedule C, Schedule E, and a monthly summary table." },
    async (uri, { year: yearVar }) => {
      const year = parseInt(String(yearVar), 10);
      if (!Number.isInteger(year) || year < 2000 || year > 2099) {
        throw new Error(`Invalid year "${yearVar}". Use a 4-digit year between 2000 and 2099.`);
      }

      // Sch C
      const schedCData = await fetchScheduleCData(year);
      const schedCMd = renderScheduleCMarkdown(schedCData);

      // Sch E
      const schedEData = await fetchScheduleEData(year);
      const schedEMd = renderScheduleEMarkdown(schedEData);

      // Monthly summary table: one row per calendar month
      const tableRows: string[] = [];
      tableRows.push("| Month | Opening Balance | Net Income | Cleared Postings |");
      tableRows.push("|-------|----------------|------------|-----------------|");

      for (let m = 1; m <= 12; m++) {
        // fetchMonthlyData with no accountId — opening balance will be null
        const fetched = await fetchMonthlyData(year, m, undefined);
        if (!fetched.ok) {
          tableRows.push(`| ${MONTH_NAMES[m - 1]} | — | — | — |`);
          continue;
        }
        const { result } = fetched.data;
        const totalIncomeMinor = result.bySegment.reduce((s, seg) => s + seg.incomeMinor, 0);
        const totalExpensesMinor = result.bySegment.reduce((s, seg) => s + seg.expensesMinor, 0);
        const netMinor = totalIncomeMinor - totalExpensesMinor;

        // Count cleared postings in this month
        const mm = String(m).padStart(2, "0");
        const periodStart = `${year}-${mm}-01`;
        const periodEnd = result.periodEnd;
        const clearedCount = await prisma.posting.count({
          where: {
            cleared: true,
            entry: { date: { gte: periodStart, lte: periodEnd } },
          },
        });

        const opening = result.openingBalanceMinor != null
          ? formatMoney(result.openingBalanceMinor)
          : "—";
        tableRows.push(
          `| ${MONTH_NAMES[m - 1]} | ${opening} | ${formatMoney(netMinor)} | ${clearedCount} |`,
        );
      }

      const markdown = [
        `# Annual Fiscal Snapshot — ${year}`,
        "",
        schedCMd,
        "",
        schedEMd,
        "",
        "## Monthly Summary",
        "",
        ...tableRows,
      ].join("\n");

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: markdown,
          },
        ],
      };
    },
  );
}
