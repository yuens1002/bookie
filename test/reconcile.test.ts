import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/db/client.js";
import { newId } from "../src/lib/id.js";
import { matchStatementToLedger } from "../src/domain/reconcile.js";

// Integration tests against the Neon dev branch. Each test creates its own
// entries and cleans up; the seeded chart of accounts is never touched.

let client: Client;
const bankId = newId("acc");
const expenseId = newId("acc");
const createdEntryIds: string[] = [];

function parse(res: CallToolResult): any {
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text);
}

/** Build a minimal signed-amount CSV with one row. */
function oneRowCsv(date: string, description: string, amountDollars: string): string {
  return `Date,Description,Amount\n${date},${description},${amountDollars}`;
}

/** Create a journal entry with two postings directly via prisma (bypasses tool validation). */
async function createEntry(
  date: string,
  description: string,
  amountMinor: number,
): Promise<{ entryId: string; paymentPostingId: string }> {
  const entryId = newId("je");
  const paymentPostingId = newId("po");
  await prisma.journalEntry.create({
    data: {
      id: entryId,
      date,
      description,
      source: "import",
      postings: {
        create: [
          { id: paymentPostingId, accountId: bankId, amount: amountMinor },
          { id: newId("po"), accountId: expenseId, amount: -amountMinor },
        ],
      },
    },
  });
  createdEntryIds.push(entryId);
  return { entryId, paymentPostingId };
}

beforeAll(async () => {
  await prisma.account.createMany({
    data: [
      { id: bankId, name: `TEST Reconcile Bank ${bankId}`, type: "asset" },
      { id: expenseId, name: `TEST Reconcile Expense ${expenseId}`, type: "expense" },
    ],
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  client = new Client({ name: "bookie-reconcile-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  // Postings cascade-deleted with entries; delete entries first, then accounts.
  await prisma.journalEntry.deleteMany({ where: { id: { in: createdEntryIds } } });
  await prisma.account.deleteMany({ where: { id: { in: [bankId, expenseId] } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Domain unit tests (no DB required)
// ---------------------------------------------------------------------------

describe("matchStatementToLedger (domain unit)", () => {
  it("matches a statement line to a ledger posting by amount + date", () => {
    const result = matchStatementToLedger({
      statementLines: [{ index: 0, date: "2026-01-10", description: "Coffee", amount: -500 }],
      ledgerPostings: [
        { id: "p1", amount: -500, entryId: "e1", date: "2026-01-10", description: "Coffee", cleared: false },
      ],
      windowDays: 4,
    });
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.postingId).toBe("p1");
    expect(result.matched[0]!.alreadyCleared).toBe(false);
    expect(result.onStatementNotInLedger).toHaveLength(0);
    expect(result.inLedgerNotOnStatement).toHaveLength(0);
  });

  it("matches within windowDays, not beyond", () => {
    const result = matchStatementToLedger({
      statementLines: [{ index: 0, date: "2026-01-10", description: "X", amount: -1000 }],
      ledgerPostings: [
        { id: "p1", amount: -1000, entryId: "e1", date: "2026-01-14", description: "X", cleared: false }, // 4 days — boundary
        { id: "p2", amount: -1000, entryId: "e2", date: "2026-01-15", description: "X", cleared: false }, // 5 days — outside
      ],
      windowDays: 4,
    });
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.postingId).toBe("p1");
    expect(result.onStatementNotInLedger).toHaveLength(0);
    expect(result.inLedgerNotOnStatement).toHaveLength(1); // p2 uncleared, unmatched
    expect(result.inLedgerNotOnStatement[0]!.id).toBe("p2");
  });

  it("puts statement line in onStatementNotInLedger when no posting matches", () => {
    const result = matchStatementToLedger({
      statementLines: [{ index: 0, date: "2026-01-10", description: "Ghost", amount: -999 }],
      ledgerPostings: [],
      windowDays: 4,
    });
    expect(result.matched).toHaveLength(0);
    expect(result.onStatementNotInLedger).toHaveLength(1);
    expect(result.onStatementNotInLedger[0]!.amount).toBe(-999);
  });

  it("puts uncleared unmatched posting in inLedgerNotOnStatement", () => {
    const result = matchStatementToLedger({
      statementLines: [],
      ledgerPostings: [
        { id: "p1", amount: -500, entryId: "e1", date: "2026-01-10", description: "X", cleared: false },
      ],
      windowDays: 4,
    });
    expect(result.inLedgerNotOnStatement).toHaveLength(1);
    expect(result.inLedgerNotOnStatement[0]!.id).toBe("p1");
  });

  it("excludes already-cleared postings from inLedgerNotOnStatement", () => {
    const result = matchStatementToLedger({
      statementLines: [],
      ledgerPostings: [
        { id: "p1", amount: -500, entryId: "e1", date: "2026-01-10", description: "X", cleared: true },
      ],
      windowDays: 4,
    });
    expect(result.inLedgerNotOnStatement).toHaveLength(0);
  });

  it("flags already-cleared posting as alreadyCleared=true when matched", () => {
    const result = matchStatementToLedger({
      statementLines: [{ index: 0, date: "2026-01-10", description: "X", amount: -500 }],
      ledgerPostings: [
        { id: "p1", amount: -500, entryId: "e1", date: "2026-01-10", description: "X", cleared: true },
      ],
      windowDays: 4,
    });
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.alreadyCleared).toBe(true);
  });

  it("consumes each posting at most once (two statement lines, one posting)", () => {
    const result = matchStatementToLedger({
      statementLines: [
        { index: 0, date: "2026-01-10", description: "A", amount: -500 },
        { index: 1, date: "2026-01-10", description: "B", amount: -500 },
      ],
      ledgerPostings: [
        { id: "p1", amount: -500, entryId: "e1", date: "2026-01-10", description: "A", cleared: false },
      ],
      windowDays: 4,
    });
    expect(result.matched).toHaveLength(1);
    expect(result.onStatementNotInLedger).toHaveLength(1); // second line had nowhere to go
  });
});

// ---------------------------------------------------------------------------
// Integration tests via MCP client
// ---------------------------------------------------------------------------

describe("reconcile — fail() branches", () => {
  it("fails when paymentAccountId does not exist", async () => {
    const res = (await client.callTool({
      name: "reconcile",
      arguments: {
        mode: "preview",
        profile: "signed-amount",
        csv: oneRowCsv("2026-01-10", "Coffee", "-5.00"),
        paymentAccountId: "acc_does_not_exist",
      },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/does not exist/);
  });

  it("fails when paymentAccountId is an income/expense account (not bank/card)", async () => {
    const res = (await client.callTool({
      name: "reconcile",
      arguments: {
        mode: "preview",
        profile: "signed-amount",
        csv: oneRowCsv("2026-01-10", "Coffee", "-5.00"),
        paymentAccountId: expenseId, // type=expense — not valid for reconcile
      },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/asset or liability/);
  });

  it("fails when CSV is malformed (bad date)", async () => {
    const res = (await client.callTool({
      name: "reconcile",
      arguments: {
        mode: "preview",
        profile: "signed-amount",
        csv: "Date,Description,Amount\n2026-99-99,Oops,-5.00",
        paymentAccountId: bankId,
      },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/CSV parse failed/);
  });

  it("fails when CSV has no data rows (header only)", async () => {
    const res = (await client.callTool({
      name: "reconcile",
      arguments: {
        mode: "preview",
        profile: "signed-amount",
        csv: "Date,Description,Amount",
        paymentAccountId: bankId,
      },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/No data rows/);
  });
});

describe("reconcile — preview mode", () => {
  it("returns matched bucket for a posting that matches the statement", async () => {
    const { paymentPostingId } = await createEntry("2026-02-01", "Matched Expense", -1500);

    const res = parse(
      (await client.callTool({
        name: "reconcile",
        arguments: {
          mode: "preview",
          profile: "signed-amount",
          csv: oneRowCsv("2026-02-01", "Matched Expense", "-15.00"),
          paymentAccountId: bankId,
        },
      })) as CallToolResult,
    );

    expect(res.mode).toBe("preview");
    expect(res.summary.matched).toBe(1);
    expect(res.matched[0].postingId).toBe(paymentPostingId);
    expect(res.matched[0].alreadyCleared).toBe(false);
  });

  it("returns onStatementNotInLedger for a statement line with no matching posting", async () => {
    const res = parse(
      (await client.callTool({
        name: "reconcile",
        arguments: {
          mode: "preview",
          profile: "signed-amount",
          csv: oneRowCsv("2026-03-01", "Phantom Charge", "-99.99"),
          paymentAccountId: bankId,
        },
      })) as CallToolResult,
    );

    expect(res.mode).toBe("preview");
    expect(res.summary.onStatementNotInLedger).toBeGreaterThanOrEqual(1);
    const found = res.onStatementNotInLedger.some(
      (l: any) => l.amountMinor === -9999,
    );
    expect(found).toBe(true);
  });

  it("returns inLedgerNotOnStatement for an uncleared posting absent from the statement", async () => {
    // Entry in scope (same date range) but NOT in the CSV
    const date = "2026-04-01";
    await createEntry(date, "Unlisted Posting", -2500);

    // Statement for a different amount on the same date — won't match
    const res = parse(
      (await client.callTool({
        name: "reconcile",
        arguments: {
          mode: "preview",
          profile: "signed-amount",
          csv: oneRowCsv(date, "Different Amount", "-1.00"),
          paymentAccountId: bankId,
          windowDays: 0,
        },
      })) as CallToolResult,
    );

    expect(res.mode).toBe("preview");
    expect(res.summary.inLedgerNotOnStatement).toBeGreaterThanOrEqual(1);
  });

  it("writes nothing in preview mode (posting stays uncleared)", async () => {
    const { paymentPostingId } = await createEntry("2026-05-01", "Preview Only", -750);

    await client.callTool({
      name: "reconcile",
      arguments: {
        mode: "preview",
        profile: "signed-amount",
        csv: oneRowCsv("2026-05-01", "Preview Only", "-7.50"),
        paymentAccountId: bankId,
      },
    });

    const posting = await prisma.posting.findUniqueOrThrow({ where: { id: paymentPostingId } });
    expect(posting.cleared).toBe(false);
    expect(posting.statementRef).toBeNull();
  });
});

describe("reconcile — commit mode", () => {
  it("marks matched posting cleared=true and sets statementRef", async () => {
    const { paymentPostingId } = await createEntry("2026-06-01", "June Expense", -3000);

    const res = parse(
      (await client.callTool({
        name: "reconcile",
        arguments: {
          mode: "commit",
          profile: "signed-amount",
          csv: oneRowCsv("2026-06-01", "June Expense", "-30.00"),
          paymentAccountId: bankId,
        },
      })) as CallToolResult,
    );

    expect(res.mode).toBe("commit");
    expect(res.summary.cleared).toBe(1);
    expect(res.cleared[0].postingId).toBe(paymentPostingId);

    const posting = await prisma.posting.findUniqueOrThrow({ where: { id: paymentPostingId } });
    expect(posting.cleared).toBe(true);
    expect(posting.statementRef).not.toBeNull();
  });

  it("is idempotent — second commit on same statement shows alreadyCleared, no error", async () => {
    const { paymentPostingId } = await createEntry("2026-07-01", "July Expense", -4000);
    const csv = oneRowCsv("2026-07-01", "July Expense", "-40.00");
    const commonArgs = {
      mode: "commit" as const,
      profile: "signed-amount" as const,
      csv,
      paymentAccountId: bankId,
    };

    // First commit clears it.
    const first = parse((await client.callTool({ name: "reconcile", arguments: commonArgs })) as CallToolResult);
    expect(first.summary.cleared).toBe(1);
    expect(first.summary.alreadyCleared).toBe(0);

    // Second commit: posting is already cleared — no DB write, no error.
    const second = parse((await client.callTool({ name: "reconcile", arguments: commonArgs })) as CallToolResult);
    expect(second.summary.cleared).toBe(0);
    expect(second.summary.alreadyCleared).toBe(1);
    expect(second.alreadyCleared[0].postingId).toBe(paymentPostingId);

    // Posting still cleared — statementRef unchanged.
    const posting = await prisma.posting.findUniqueOrThrow({ where: { id: paymentPostingId } });
    expect(posting.cleared).toBe(true);
  });

  it("returns discrepancy buckets alongside cleared entries", async () => {
    const date = "2026-08-01";
    // One matching entry + one uncleared entry not on statement
    await createEntry(date, "On Statement", -500);
    await createEntry(date, "Not On Statement", -888);

    const res = parse(
      (await client.callTool({
        name: "reconcile",
        arguments: {
          mode: "commit",
          profile: "signed-amount",
          // Statement has the -500 row and a mystery row not in the ledger
          csv: `Date,Description,Amount\n${date},On Statement,-5.00\n${date},Phantom Charge,-77.77`,
          paymentAccountId: bankId,
          windowDays: 0,
        },
      })) as CallToolResult,
    );

    expect(res.summary.cleared).toBe(1);
    expect(res.summary.onStatementNotInLedger).toBe(1); // phantom charge
    expect(res.summary.inLedgerNotOnStatement).toBeGreaterThanOrEqual(1); // -888 entry
    expect(res.onStatementNotInLedger[0].amountMinor).toBe(-7777);
  });

  it("returns cleared=0 with no error when nothing matches", async () => {
    const res = parse(
      (await client.callTool({
        name: "reconcile",
        arguments: {
          mode: "commit",
          profile: "signed-amount",
          csv: oneRowCsv("2020-01-01", "Ancient History", "-0.01"),
          paymentAccountId: bankId,
          windowDays: 0,
        },
      })) as CallToolResult,
    );

    expect(res.isError).toBeUndefined();
    expect(res.summary.cleared).toBe(0);
    expect(res.summary.onStatementNotInLedger).toBe(1);
  });
});
