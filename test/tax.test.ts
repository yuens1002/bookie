import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/db/client.js";
import { newId } from "../src/lib/id.js";
import {
  computeScheduleC,
  computeScheduleE,
  type TaxPosting,
} from "../src/domain/tax.js";

// Integration tests use year 2025 to avoid date collisions with other test suites.

let client: Client;
const segCId = newId("seg");
const segEId = newId("seg");
const accCIncomeId = newId("acc");
const accCExpenseId = newId("acc");
const accEIncomeId = newId("acc");
const accEExpenseId = newId("acc");
const bankTaxId = newId("acc");
const propId = newId("prop");
const createdEntryIds: string[] = [];

function parse(res: CallToolResult): any {
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text);
}

beforeAll(async () => {
  await prisma.segment.create({
    data: { id: segCId, name: `TEST TaxC ${segCId}`, taxSchedule: "C" },
  });
  await prisma.segment.create({
    data: { id: segEId, name: `TEST TaxE ${segEId}`, taxSchedule: "E" },
  });

  await prisma.account.createMany({
    data: [
      {
        id: accCIncomeId,
        name: `TEST C Income ${accCIncomeId}`,
        type: "income",
        segmentId: segCId,
        taxLine: "Line 1 — Gross receipts",
      },
      {
        id: accCExpenseId,
        name: `TEST C Expense ${accCExpenseId}`,
        type: "expense",
        segmentId: segCId,
        taxLine: "Line 9 — Car and truck",
      },
      {
        id: accEIncomeId,
        name: `TEST E Income ${accEIncomeId}`,
        type: "income",
        segmentId: segEId,
        taxLine: "Rents received",
      },
      {
        id: accEExpenseId,
        name: `TEST E Expense ${accEExpenseId}`,
        type: "expense",
        segmentId: segEId,
        taxLine: "Line 14 — Repairs",
      },
      { id: bankTaxId, name: `TEST Tax Bank ${bankTaxId}`, type: "asset" },
    ],
  });

  await prisma.property.create({ data: { id: propId, name: "TEST 123 Main St" } });

  // Schedule C entries — $5,000 income, $1,200 expense
  const eCIncome = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: eCIncome,
      date: "2025-03-15",
      description: "Consulting fee",
      postings: {
        create: [
          { id: newId("po"), accountId: bankTaxId, amount: 500000 },
          { id: newId("po"), accountId: accCIncomeId, amount: -500000 },
        ],
      },
    },
  });
  createdEntryIds.push(eCIncome);

  const eCExpense = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: eCExpense,
      date: "2025-06-01",
      description: "Car expense",
      postings: {
        create: [
          { id: newId("po"), accountId: bankTaxId, amount: -120000 },
          { id: newId("po"), accountId: accCExpenseId, amount: 120000 },
        ],
      },
    },
  });
  createdEntryIds.push(eCExpense);

  // Schedule E entries — $2,400 rent income, $500 repair expense (both on propId)
  const eERent = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: eERent,
      date: "2025-01-01",
      description: "Rent payment",
      propertyId: propId,
      postings: {
        create: [
          { id: newId("po"), accountId: bankTaxId, amount: 240000 },
          { id: newId("po"), accountId: accEIncomeId, amount: -240000 },
        ],
      },
    },
  });
  createdEntryIds.push(eERent);

  const eERepair = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: eERepair,
      date: "2025-04-01",
      description: "Plumbing repair",
      propertyId: propId,
      postings: {
        create: [
          { id: newId("po"), accountId: bankTaxId, amount: -50000 },
          { id: newId("po"), accountId: accEExpenseId, amount: 50000 },
        ],
      },
    },
  });
  createdEntryIds.push(eERepair);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  client = new Client({ name: "bookie-tax-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await prisma.journalEntry.deleteMany({ where: { id: { in: createdEntryIds } } });
  await prisma.account.deleteMany({
    where: { id: { in: [accCIncomeId, accCExpenseId, accEIncomeId, accEExpenseId, bankTaxId] } },
  });
  await prisma.segment.deleteMany({ where: { id: { in: [segCId, segEId] } } });
  await prisma.property.deleteMany({ where: { id: propId } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// computeScheduleC — domain unit tests (no DB)
// ---------------------------------------------------------------------------

describe("computeScheduleC (domain unit)", () => {
  const makePosting = (overrides: Partial<TaxPosting>): TaxPosting => ({
    id: newId("po"),
    amount: 1000,
    accountId: "acc_1",
    accountType: "expense",
    accountName: "Test Account",
    taxLine: "Line 9 — Car and truck",
    entryId: "je_1",
    entryDate: "2025-01-01",
    propertyId: null,
    propertyName: null,
    ...overrides,
  });

  it("groups income and expense postings by taxLine", () => {
    const result = computeScheduleC(
      [
        makePosting({ accountType: "income", amount: -500000, taxLine: "Line 1 — Gross receipts" }),
        makePosting({ accountType: "expense", amount: 120000, taxLine: "Line 9 — Car and truck" }),
        makePosting({ accountType: "expense", amount: 50000, taxLine: "Line 9 — Car and truck" }),
      ],
      2025,
    );
    expect(result.incomeLines).toHaveLength(1);
    expect(result.incomeLines[0]!.taxLine).toBe("Line 1 — Gross receipts");
    expect(result.incomeLines[0]!.totalMinor).toBe(500000); // sign-flipped from -500000
    expect(result.expenseLines).toHaveLength(1);
    expect(result.expenseLines[0]!.taxLine).toBe("Line 9 — Car and truck");
    expect(result.expenseLines[0]!.totalMinor).toBe(170000); // 120000 + 50000
  });

  it("puts null-taxLine postings in an Unclassified bucket", () => {
    const result = computeScheduleC(
      [makePosting({ accountType: "expense", amount: 10000, taxLine: null })],
      2025,
    );
    expect(result.expenseLines[0]!.taxLine).toBe("Unclassified");
    expect(result.expenseLines[0]!.totalMinor).toBe(10000);
  });

  it("sorts lines alphabetically with Unclassified last", () => {
    const result = computeScheduleC(
      [
        makePosting({ accountType: "expense", amount: 1000, taxLine: null }),
        makePosting({ accountType: "expense", amount: 2000, taxLine: "Z Line" }),
        makePosting({ accountType: "expense", amount: 3000, taxLine: "A Line" }),
      ],
      2025,
    );
    expect(result.expenseLines[0]!.taxLine).toBe("A Line");
    expect(result.expenseLines[1]!.taxLine).toBe("Z Line");
    expect(result.expenseLines[2]!.taxLine).toBe("Unclassified");
  });

  it("computes net correctly (income minus expenses)", () => {
    const result = computeScheduleC(
      [
        makePosting({ accountType: "income", amount: -500000, taxLine: "Revenue" }),
        makePosting({ accountType: "expense", amount: 120000, taxLine: "Costs" }),
      ],
      2025,
    );
    expect(result.totalIncomeMinor).toBe(500000);
    expect(result.totalExpensesMinor).toBe(120000);
    expect(result.netMinor).toBe(380000);
  });

  it("returns empty arrays for an empty posting list", () => {
    const result = computeScheduleC([], 2025);
    expect(result.incomeLines).toHaveLength(0);
    expect(result.expenseLines).toHaveLength(0);
    expect(result.netMinor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeScheduleE — domain unit tests (no DB)
// ---------------------------------------------------------------------------

describe("computeScheduleE (domain unit)", () => {
  const makePosting = (overrides: Partial<TaxPosting>): TaxPosting => ({
    id: newId("po"),
    amount: -240000,
    accountId: "acc_1",
    accountType: "income",
    accountName: "Rental Income",
    taxLine: "Rents received",
    entryId: "je_1",
    entryDate: "2025-01-01",
    propertyId: "prop_1",
    propertyName: "123 Main St",
    ...overrides,
  });

  it("groups postings by property", () => {
    const result = computeScheduleE(
      [
        makePosting({ propertyId: "prop_1", propertyName: "123 Main St", amount: -240000 }),
        makePosting({ propertyId: "prop_2", propertyName: "456 Oak Ave", amount: -180000 }),
      ],
      2025,
    );
    expect(result.properties).toHaveLength(2);
    // sorted by propertyId alphabetically
    expect(result.properties[0]!.propertyName).toBe("123 Main St");
    expect(result.properties[1]!.propertyName).toBe("456 Oak Ave");
  });

  it("routes null-propertyId postings into an Unassigned bucket", () => {
    const result = computeScheduleE(
      [makePosting({ propertyId: null, propertyName: null, amount: -100000 })],
      2025,
    );
    expect(result.properties).toHaveLength(1);
    expect(result.properties[0]!.propertyId).toBeNull();
    expect(result.properties[0]!.propertyName).toBe("Unassigned");
  });

  it("sorts properties alphabetically with Unassigned (null) last", () => {
    const result = computeScheduleE(
      [
        makePosting({ propertyId: null, propertyName: null }),
        makePosting({ propertyId: "prop_z", propertyName: "Z Property" }),
        makePosting({ propertyId: "prop_a", propertyName: "A Property" }),
      ],
      2025,
    );
    expect(result.properties[0]!.propertyId).toBe("prop_a");
    expect(result.properties[1]!.propertyId).toBe("prop_z");
    expect(result.properties[2]!.propertyId).toBeNull();
  });

  it("computes per-property income, expenses, and net", () => {
    const result = computeScheduleE(
      [
        makePosting({ propertyId: "prop_1", propertyName: "Main St", amount: -240000, accountType: "income" }),
        makePosting({
          propertyId: "prop_1",
          propertyName: "Main St",
          amount: 50000,
          accountType: "expense",
          taxLine: "Line 14 — Repairs",
        }),
      ],
      2025,
    );
    expect(result.properties[0]!.totalIncomeMinor).toBe(240000);
    expect(result.properties[0]!.totalExpensesMinor).toBe(50000);
    expect(result.properties[0]!.netMinor).toBe(190000);
    expect(result.totalNetMinor).toBe(190000);
  });

  it("aggregates totalNetMinor across all properties", () => {
    const result = computeScheduleE(
      [
        makePosting({ propertyId: "prop_1", propertyName: "P1", amount: -200000, accountType: "income" }),
        makePosting({ propertyId: "prop_2", propertyName: "P2", amount: -100000, accountType: "income" }),
      ],
      2025,
    );
    expect(result.totalNetMinor).toBe(300000); // 200000 + 100000
  });
});

// ---------------------------------------------------------------------------
// generate_report — validation failures (tax types)
// ---------------------------------------------------------------------------

describe("generate_report — fail() branches (tax types)", () => {
  it("fails for schedule-c when month is supplied", async () => {
    const res = (await client.callTool({
      name: "generate_report",
      arguments: { type: "schedule-c", year: 2025, month: 3 },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/must not be supplied/);
  });

  it("fails for schedule-e when month is supplied", async () => {
    const res = (await client.callTool({
      name: "generate_report",
      arguments: { type: "schedule-e", year: 2025, month: 1 },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/must not be supplied/);
  });

  it("fails for monthly-reconciliation when month is missing", async () => {
    const res = (await client.callTool({
      name: "generate_report",
      arguments: { type: "monthly-reconciliation", year: 2025 },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/month is required/);
  });
});

// ---------------------------------------------------------------------------
// generate_report — schedule-c integration
// ---------------------------------------------------------------------------

describe("generate_report — schedule-c", () => {
  it("returns type, year, summary, and line arrays", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "schedule-c", year: 2025 },
      })) as CallToolResult,
    );
    expect(res.type).toBe("schedule-c");
    expect(res.year).toBe(2025);
    expect(Array.isArray(res.incomeLines)).toBe(true);
    expect(Array.isArray(res.expenseLines)).toBe(true);
    expect(res.summary).toBeDefined();
  });

  it("income line contains the test account at the correct total", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "schedule-c", year: 2025 },
      })) as CallToolResult,
    );
    const line = (res.incomeLines as any[]).find((l: any) =>
      l.accounts.some((a: any) => a.accountId === accCIncomeId),
    );
    expect(line).toBeDefined();
    expect(line.taxLine).toBe("Line 1 — Gross receipts");
    const acct = line.accounts.find((a: any) => a.accountId === accCIncomeId);
    expect(acct.totalMinor).toBe(500000); // $5,000 consulting fee
  });

  it("expense line contains the test account at the correct total", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "schedule-c", year: 2025 },
      })) as CallToolResult,
    );
    const line = (res.expenseLines as any[]).find((l: any) =>
      l.accounts.some((a: any) => a.accountId === accCExpenseId),
    );
    expect(line).toBeDefined();
    expect(line.taxLine).toBe("Line 9 — Car and truck");
    const acct = line.accounts.find((a: any) => a.accountId === accCExpenseId);
    expect(acct.totalMinor).toBe(120000); // $1,200 car expense
  });

  it("summary totals reflect at least the seeded entries", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "schedule-c", year: 2025 },
      })) as CallToolResult,
    );
    expect(res.summary.totalIncomeMinor).toBeGreaterThanOrEqual(500000);
    expect(res.summary.totalExpensesMinor).toBeGreaterThanOrEqual(120000);
  });
});

// ---------------------------------------------------------------------------
// generate_report — schedule-e integration
// ---------------------------------------------------------------------------

describe("generate_report — schedule-e", () => {
  it("returns type, year, properties array, and totalNetMinor", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "schedule-e", year: 2025 },
      })) as CallToolResult,
    );
    expect(res.type).toBe("schedule-e");
    expect(res.year).toBe(2025);
    expect(Array.isArray(res.properties)).toBe(true);
    expect(typeof res.totalNetMinor).toBe("number");
  });

  it("test property shows correct income and expense totals", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "schedule-e", year: 2025 },
      })) as CallToolResult,
    );
    const prop = (res.properties as any[]).find((p: any) => p.propertyId === propId);
    expect(prop).toBeDefined();
    expect(prop.totalIncomeMinor).toBe(240000); // $2,400 rent
    expect(prop.totalExpensesMinor).toBe(50000); // $500 repair
    expect(prop.netMinor).toBe(190000);
  });

  it("property income line is correctly grouped under 'Rents received'", async () => {
    const res = parse(
      (await client.callTool({
        name: "generate_report",
        arguments: { type: "schedule-e", year: 2025 },
      })) as CallToolResult,
    );
    const prop = (res.properties as any[]).find((p: any) => p.propertyId === propId);
    const incomeLine = (prop.incomeLines as any[]).find(
      (l: any) => l.taxLine === "Rents received",
    );
    expect(incomeLine).toBeDefined();
    const acct = incomeLine.accounts.find((a: any) => a.accountId === accEIncomeId);
    expect(acct.totalMinor).toBe(240000);
  });
});

// ---------------------------------------------------------------------------
// export_report
// ---------------------------------------------------------------------------

describe("export_report", () => {
  it("fails when month is missing for monthly-reconciliation", async () => {
    const res = (await client.callTool({
      name: "export_report",
      arguments: { type: "monthly-reconciliation", year: 2025, format: "markdown" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/month is required/);
  });

  it("fails when month is supplied for schedule-c", async () => {
    const res = (await client.callTool({
      name: "export_report",
      arguments: { type: "schedule-c", year: 2025, month: 3, format: "csv" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/must not be supplied/);
  });

  it("schedule-c markdown contains the report header and test tax lines", async () => {
    const res = parse(
      (await client.callTool({
        name: "export_report",
        arguments: { type: "schedule-c", year: 2025, format: "markdown" },
      })) as CallToolResult,
    );
    expect(res.format).toBe("markdown");
    expect(typeof res.output).toBe("string");
    expect(res.output).toContain("Schedule C");
    expect(res.output).toContain("2025");
    expect(res.output).toContain("Line 1 — Gross receipts");
    expect(res.output).toContain("Line 9 — Car and truck");
  });

  it("schedule-c CSV has the correct header row", async () => {
    const res = parse(
      (await client.callTool({
        name: "export_report",
        arguments: { type: "schedule-c", year: 2025, format: "csv" },
      })) as CallToolResult,
    );
    expect(res.format).toBe("csv");
    const firstLine = (res.output as string).split("\n")[0];
    expect(firstLine).toBe("type,taxLine,accountId,accountName,amountMinor,amount");
  });

  it("schedule-e markdown contains the property name", async () => {
    const res = parse(
      (await client.callTool({
        name: "export_report",
        arguments: { type: "schedule-e", year: 2025, format: "markdown" },
      })) as CallToolResult,
    );
    expect(res.format).toBe("markdown");
    expect(res.output).toContain("Schedule E");
    expect(res.output).toContain("TEST 123 Main St");
  });

  it("schedule-e CSV has the correct header row", async () => {
    const res = parse(
      (await client.callTool({
        name: "export_report",
        arguments: { type: "schedule-e", year: 2025, format: "csv" },
      })) as CallToolResult,
    );
    expect(res.format).toBe("csv");
    const firstLine = (res.output as string).split("\n")[0];
    expect(firstLine).toBe(
      "propertyId,propertyName,type,taxLine,accountId,accountName,amountMinor,amount",
    );
  });

  it("monthly-reconciliation markdown contains the period header", async () => {
    const res = parse(
      (await client.callTool({
        name: "export_report",
        arguments: { type: "monthly-reconciliation", year: 2025, month: 3, format: "markdown" },
      })) as CallToolResult,
    );
    expect(res.format).toBe("markdown");
    expect(res.output).toContain("Monthly Reconciliation");
    expect(res.output).toContain("March 2025");
  });

  it("monthly-reconciliation CSV has the correct header row", async () => {
    const res = parse(
      (await client.callTool({
        name: "export_report",
        arguments: { type: "monthly-reconciliation", year: 2025, month: 3, format: "csv" },
      })) as CallToolResult,
    );
    expect(res.format).toBe("csv");
    const firstLine = (res.output as string).split("\n")[0];
    expect(firstLine).toBe("segment,incomeMinor,income,expensesMinor,expenses,netMinor,net");
  });
});
