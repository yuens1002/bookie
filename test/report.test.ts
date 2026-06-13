import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/db/client.js";
import { newId } from "../src/lib/id.js";
import {
  computeMonthlyReport,
  lastDayOfMonth,
  type ReportPosting,
  type ReportEntry,
} from "../src/domain/report.js";

// Integration tests use 2026-10 to avoid date collisions with other test suites.

let client: Client;
const segBizId = newId("seg");
const bankId = newId("acc");
const bizExpenseId = newId("acc");
const bizIncomeId = newId("acc");
const equityId = newId("acc"); // for uncategorized entries (no income/expense leg)
const createdEntryIds: string[] = [];

function parse(res: CallToolResult): any {
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text);
}

beforeAll(async () => {
  // Segment
  await prisma.segment.create({
    data: { id: segBizId, name: `TEST Report Biz ${segBizId}`, taxSchedule: "C" },
  });

  // Accounts
  await prisma.account.createMany({
    data: [
      { id: bankId, name: `TEST Report Bank ${bankId}`, type: "asset" },
      { id: bizExpenseId, name: `TEST Report BizExp ${bizExpenseId}`, type: "expense", segmentId: segBizId },
      { id: bizIncomeId, name: `TEST Report BizInc ${bizIncomeId}`, type: "income", segmentId: segBizId },
      { id: equityId, name: `TEST Report Equity ${equityId}`, type: "equity" },
    ],
  });

  // October 2026 entries
  // 1. Expense $100 — business
  const e1 = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: e1,
      date: "2026-10-05",
      description: "Hosting bill",
      source: "import",
      postings: {
        create: [
          { id: newId("po"), accountId: bankId, amount: -10000, cleared: true },
          { id: newId("po"), accountId: bizExpenseId, amount: 10000 },
        ],
      },
    },
  });
  createdEntryIds.push(e1);

  // 2. Income $500 — business
  const e2 = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: e2,
      date: "2026-10-10",
      description: "Client invoice",
      source: "manual",
      postings: {
        create: [
          { id: newId("po"), accountId: bankId, amount: 50000, cleared: true },
          { id: newId("po"), accountId: bizIncomeId, amount: -50000 },
        ],
      },
    },
  });
  createdEntryIds.push(e2);

  // 3. Uncategorized: bank ↔ equity (no income/expense leg)
  const e3 = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: e3,
      date: "2026-10-15",
      description: "Owner draw",
      source: "manual",
      postings: {
        create: [
          { id: newId("po"), accountId: bankId, amount: -5000, cleared: false },
          { id: newId("po"), accountId: equityId, amount: 5000 },
        ],
      },
    },
  });
  createdEntryIds.push(e3);

  // Pre-month entry (September) — contributes to opening balance only
  const e0 = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: e0,
      date: "2026-09-01",
      description: "Opening deposit",
      source: "manual",
      postings: {
        create: [
          { id: newId("po"), accountId: bankId, amount: 100000, cleared: true },
          { id: newId("po"), accountId: equityId, amount: -100000 },
        ],
      },
    },
  });
  createdEntryIds.push(e0);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  client = new Client({ name: "bookie-report-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await prisma.journalEntry.deleteMany({ where: { id: { in: createdEntryIds } } });
  await prisma.account.deleteMany({ where: { id: { in: [bankId, bizExpenseId, bizIncomeId, equityId] } } });
  await prisma.segment.deleteMany({ where: { id: segBizId } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Domain unit tests (no DB required)
// ---------------------------------------------------------------------------

describe("computeMonthlyReport (domain unit)", () => {
  const makePosting = (
    overrides: Partial<ReportPosting> & Pick<ReportPosting, "accountType">,
  ): ReportPosting => ({
    id: newId("po"),
    amount: 1000,
    accountId: "acc_1",
    accountName: "Test Account",
    segmentId: null,
    segmentName: null,
    cleared: true,
    entryId: "je_1",
    entryDate: "2026-10-01",
    entryDescription: "Test",
    ...overrides,
  });

  it("lastDayOfMonth returns correct last day for various months", () => {
    expect(lastDayOfMonth(2026, 1)).toBe("2026-01-31");
    expect(lastDayOfMonth(2026, 2)).toBe("2026-02-28");
    expect(lastDayOfMonth(2024, 2)).toBe("2024-02-29"); // leap year
    expect(lastDayOfMonth(2026, 12)).toBe("2026-12-31");
  });

  it("computes income and expense totals by segment", () => {
    const result = computeMonthlyReport({
      year: 2026,
      month: 10,
      accountId: null,
      accountName: null,
      preMonthAccountPostings: [],
      monthPostings: [
        makePosting({ accountType: "expense", amount: 5000, segmentId: "seg_1", segmentName: "Biz" }),
        makePosting({ accountType: "income", amount: -20000, segmentId: "seg_1", segmentName: "Biz" }),
      ],
      monthEntries: [],
    });

    expect(result.bySegment).toHaveLength(1);
    const seg = result.bySegment[0]!;
    expect(seg.segmentId).toBe("seg_1");
    expect(seg.expensesMinor).toBe(5000);
    expect(seg.incomeMinor).toBe(20000); // negated from -20000
    expect(seg.netMinor).toBe(15000); // 20000 - 5000
  });

  it("returns null opening/closing balance when no accountId supplied", () => {
    const result = computeMonthlyReport({
      year: 2026,
      month: 10,
      accountId: null,
      accountName: null,
      preMonthAccountPostings: [{ amount: 50000 }],
      monthPostings: [],
      monthEntries: [],
    });
    expect(result.openingBalanceMinor).toBeNull();
    expect(result.closingBalanceMinor).toBeNull();
  });

  it("computes opening and closing balance when accountId is supplied", () => {
    const result = computeMonthlyReport({
      year: 2026,
      month: 10,
      accountId: "acc_bank",
      accountName: "Checking",
      preMonthAccountPostings: [{ amount: 100000 }, { amount: -20000 }],
      monthPostings: [
        makePosting({ accountId: "acc_bank", accountType: "asset", amount: 50000, cleared: true }),
        makePosting({ accountId: "acc_bank", accountType: "asset", amount: -10000, cleared: true }),
      ],
      monthEntries: [],
    });

    expect(result.openingBalanceMinor).toBe(80000); // 100000 - 20000
    expect(result.closingBalanceMinor).toBe(120000); // 80000 + 50000 - 10000
  });

  it("flags entries with no income/expense leg as uncategorized", () => {
    const entries: ReportEntry[] = [
      { id: "je_cat", date: "2026-10-01", description: "Categorized", postingAccountTypes: ["asset", "expense"] },
      { id: "je_uncat", date: "2026-10-02", description: "Transfer", postingAccountTypes: ["asset", "equity"] },
    ];
    const result = computeMonthlyReport({
      year: 2026,
      month: 10,
      accountId: null,
      accountName: null,
      preMonthAccountPostings: [],
      monthPostings: [],
      monthEntries: entries,
    });
    expect(result.uncategorizedEntries).toHaveLength(1);
    expect(result.uncategorizedEntries[0]!.entryId).toBe("je_uncat");
  });

  it("flags uncleared asset/liability postings as discrepancies", () => {
    const unclearedId = "po_uncleared_fixed";
    const result = computeMonthlyReport({
      year: 2026,
      month: 10,
      accountId: null,
      accountName: null,
      preMonthAccountPostings: [],
      monthPostings: [
        makePosting({ id: unclearedId, accountType: "asset", cleared: false }),
        makePosting({ id: "po_cleared_fixed", accountType: "asset", cleared: true }), // cleared — not flagged
        makePosting({ id: "po_expense_fixed", accountType: "expense", cleared: false }), // expense — not flagged
      ],
      monthEntries: [],
    });
    expect(result.unclearedPaymentPostings).toHaveLength(1);
    expect(result.unclearedPaymentPostings[0]!.postingId).toBe(unclearedId);
  });
});

// ---------------------------------------------------------------------------
// Integration tests via MCP client
// ---------------------------------------------------------------------------

describe("generate_report — fail() branches", () => {
  it("fails when accountId does not exist", async () => {
    const res = (await client.callTool({
      name: "generate_report",
      arguments: { type: "monthly-reconciliation", year: 2026, month: 10, accountId: "acc_doesnotexist" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/does not exist/);
  });

  it("fails when accountId is an income/expense account", async () => {
    const res = (await client.callTool({
      name: "generate_report",
      arguments: { type: "monthly-reconciliation", year: 2026, month: 10, accountId: bizExpenseId },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/asset or liability/);
  });
});

describe("generate_report — monthly-reconciliation", () => {
  it("returns periodStart and periodEnd for the requested month", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "monthly-reconciliation", year: 2026, month: 10 },
      })) as CallToolResult,
    );
    expect(res.periodStart).toBe("2026-10-01");
    expect(res.periodEnd).toBe("2026-10-31");
  });

  it("includes the test segment's income and expense totals", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "monthly-reconciliation", year: 2026, month: 10 },
      })) as CallToolResult,
    );

    const seg = (res.bySegment as any[]).find((s) => s.segmentId === segBizId);
    expect(seg).toBeDefined();
    expect(seg.expensesMinor).toBeGreaterThanOrEqual(10000); // $100 expense
    expect(seg.incomeMinor).toBeGreaterThanOrEqual(50000); // $500 income
    expect(seg.netMinor).toBeGreaterThan(0); // profitable
  });

  it("flags the owner draw (equity-only) as uncategorized", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "monthly-reconciliation", year: 2026, month: 10 },
      })) as CallToolResult,
    );

    const uncategorized = res.uncategorizedEntries as any[];
    const found = uncategorized.some((e) => e.description === "Owner draw");
    expect(found).toBe(true);
  });

  it("flags the uncleared bank posting as a discrepancy", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "monthly-reconciliation", year: 2026, month: 10 },
      })) as CallToolResult,
    );

    const uncleared = res.unclearedPaymentPostings as any[];
    const found = uncleared.some((p) => p.description === "Owner draw" && p.accountId === bankId);
    expect(found).toBe(true);
  });

  it("computes opening and closing balance when accountId is provided", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "monthly-reconciliation", year: 2026, month: 10, accountId: bankId },
      })) as CallToolResult,
    );

    // Pre-month: opening deposit of $1,000 (100000 minor)
    expect(res.openingBalanceMinor).toBe(100000);
    // In-month: -10000 (expense) + 50000 (income) - 5000 (owner draw) = +35000
    expect(res.closingBalanceMinor).toBe(135000);
    expect(res.account.id).toBe(bankId);
  });

  it("returns empty report without error for a month with no entries", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "monthly-reconciliation", year: 2020, month: 1 },
      })) as CallToolResult,
    );
    expect(res.bySegment).toHaveLength(0);
    expect(res.summary.totalIncomeMinor).toBe(0);
    expect(res.summary.totalExpensesMinor).toBe(0);
    expect(res.uncategorizedEntries).toHaveLength(0);
    expect(res.unclearedPaymentPostings).toHaveLength(0);
  });
});
