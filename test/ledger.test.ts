import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/db/client.js";
import { newId } from "../src/lib/id.js";

// Integration tests run against the configured DB (the Neon "dev" branch via
// .env). They create throwaway accounts/entries and clean up after themselves,
// so the seeded chart is never touched. For CI, point BOOKIE_DB_URL at an
// ephemeral branch.

let client: Client;
const segmentId = newId("seg");
const bankId = newId("acc");
const expenseId = newId("acc");
const expense2Id = newId("acc");
const incomeId = newId("acc");
const propertyId = newId("prop");
const createdEntryIds: string[] = [];
const createdSegmentIds: string[] = [];

function parse(res: CallToolResult): any {
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text);
}

beforeAll(async () => {
  await prisma.segment.create({ data: { id: segmentId, name: `TEST Segment ${segmentId}`, taxSchedule: "E" } });
  await prisma.account.createMany({
    data: [
      // bank is segment-neutral (asset); category accounts belong to the segment
      { id: bankId, name: `TEST Bank ${bankId}`, type: "asset" },
      { id: expenseId, name: `TEST Supplies ${expenseId}`, type: "expense", segmentId },
      { id: expense2Id, name: `TEST Groceries ${expense2Id}`, type: "expense", segmentId },
      { id: incomeId, name: `TEST Rent Income ${incomeId}`, type: "income", segmentId },
    ],
  });
  await prisma.property.create({ data: { id: propertyId, name: `TEST Property ${propertyId}` } });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  client = new Client({ name: "bookie-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await prisma.posting.deleteMany({ where: { accountId: { in: [bankId, expenseId, expense2Id, incomeId] } } });
  await prisma.journalEntry.deleteMany({ where: { id: { in: createdEntryIds } } });
  await prisma.account.deleteMany({ where: { id: { in: [bankId, expenseId, expense2Id, incomeId] } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.segment.deleteMany({ where: { id: { in: [segmentId, ...createdSegmentIds] } } });
  await prisma.$disconnect();
});

describe("manage_segments", () => {
  it("creates, lists, then archives a segment", async () => {
    const created = parse(
      (await client.callTool({
        name: "manage_segments",
        arguments: { action: "create", name: `TEST Seg ${newId("x")}`, taxSchedule: "C" },
      })) as CallToolResult,
    );
    const id = created.created.id;
    createdSegmentIds.push(id);
    expect(created.created.taxSchedule).toBe("C");

    const listed = parse(
      (await client.callTool({ name: "manage_segments", arguments: { action: "list" } })) as CallToolResult,
    );
    expect(listed.some((s: any) => s.id === id)).toBe(true);

    const arch = parse(
      (await client.callTool({ name: "manage_segments", arguments: { action: "archive", id } })) as CallToolResult,
    );
    expect(arch.archived).toBe(id);

    const after = parse(
      (await client.callTool({ name: "manage_segments", arguments: { action: "list" } })) as CallToolResult,
    );
    expect(after.some((s: any) => s.id === id)).toBe(false); // archived excluded by default
  });

  it("errors archiving an unknown segment id", async () => {
    const res = (await client.callTool({
      name: "manage_segments",
      arguments: { action: "archive", id: "seg_missing" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});

describe("add_transaction", () => {
  it("creates a balanced double-entry (postings sum to zero)", async () => {
    const res = parse(
      (await client.callTool({
        name: "add_transaction",
        arguments: {
          date: "2026-05-10",
          description: "TEST printer paper",
          amount: 42.5,
          fromAccountId: bankId,
          toAccountId: expenseId,
        },
      })) as CallToolResult,
    );
    createdEntryIds.push(res.entryId);

    const postings = await prisma.posting.findMany({ where: { entryId: res.entryId } });
    expect(postings).toHaveLength(2);
    expect(postings.reduce((sum, p) => sum + p.amount, 0)).toBe(0);
    expect(postings.find((p) => p.accountId === expenseId)?.amount).toBe(4250); // debit
    expect(postings.find((p) => p.accountId === bankId)?.amount).toBe(-4250); // credit
  });

  it("rejects identical from/to accounts", async () => {
    const res = (await client.callTool({
      name: "add_transaction",
      arguments: { date: "2026-05-10", description: "bad", amount: 1, fromAccountId: bankId, toAccountId: bankId },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("rejects an unknown account id", async () => {
    const res = (await client.callTool({
      name: "add_transaction",
      arguments: { date: "2026-05-10", description: "bad", amount: 1, fromAccountId: bankId, toAccountId: "acc_missing" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});

describe("account_balances", () => {
  it("reflects the posted amounts for our accounts", async () => {
    const rows = parse(
      (await client.callTool({ name: "account_balances", arguments: {} })) as CallToolResult,
    );
    expect(rows.find((r: any) => r.id === expenseId)?.balanceMinor).toBe(4250);
    expect(rows.find((r: any) => r.id === bankId)?.balanceMinor).toBe(-4250);
  });
});

describe("query_transactions", () => {
  it("returns entries with their postings, filtered by account", async () => {
    const rows = parse(
      (await client.callTool({
        name: "query_transactions",
        arguments: { accountId: expenseId },
      })) as CallToolResult,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].postings).toHaveLength(2);
  });
});

describe("split_transaction", () => {
  it("creates one balanced entry with a single payment leg + category legs", async () => {
    const res = parse(
      (await client.callTool({
        name: "split_transaction",
        arguments: {
          date: "2026-05-14",
          description: "TEST Costco split",
          paymentAccountId: bankId,
          legs: [
            { accountId: expenseId, amount: 80 },
            { accountId: expense2Id, amount: 132.55 },
          ],
        },
      })) as CallToolResult,
    );
    createdEntryIds.push(res.entryId);

    const postings = await prisma.posting.findMany({ where: { entryId: res.entryId } });
    expect(postings).toHaveLength(3);
    expect(postings.reduce((sum, p) => sum + p.amount, 0)).toBe(0);
    // single payment leg = what a statement line reconciles against
    expect(postings.filter((p) => p.accountId === bankId)).toHaveLength(1);
    expect(postings.find((p) => p.accountId === bankId)?.amount).toBe(-21255);
    expect(postings.find((p) => p.accountId === expenseId)?.amount).toBe(8000);
    expect(postings.find((p) => p.accountId === expense2Id)?.amount).toBe(13255);
  });

  it("rejects paymentAccountId that also appears as a category leg", async () => {
    const res = (await client.callTool({
      name: "split_transaction",
      arguments: {
        date: "2026-05-14",
        description: "bad",
        paymentAccountId: bankId,
        legs: [{ accountId: bankId, amount: 10 }],
      },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("supports income direction (payment debited, income credited)", async () => {
    const res = parse(
      (await client.callTool({
        name: "split_transaction",
        arguments: {
          date: "2026-05-15",
          description: "TEST rent received",
          paymentAccountId: bankId,
          direction: "income",
          legs: [{ accountId: incomeId, amount: 1000 }],
        },
      })) as CallToolResult,
    );
    createdEntryIds.push(res.entryId);

    const postings = await prisma.posting.findMany({ where: { entryId: res.entryId } });
    expect(postings.reduce((sum, p) => sum + p.amount, 0)).toBe(0);
    expect(postings.find((p) => p.accountId === bankId)?.amount).toBe(100000); // debit, cash up
    expect(postings.find((p) => p.accountId === incomeId)?.amount).toBe(-100000); // credit
  });

  it("rejects an unknown leg account id", async () => {
    const res = (await client.callTool({
      name: "split_transaction",
      arguments: {
        date: "2026-05-15",
        description: "bad",
        paymentAccountId: bankId,
        legs: [{ accountId: "acc_missing", amount: 5 }],
      },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});

describe("property tagging (Schedule E)", () => {
  it("tags an entry with a propertyId", async () => {
    const res = parse(
      (await client.callTool({
        name: "add_transaction",
        arguments: {
          date: "2026-05-12",
          description: "TEST roof repair",
          amount: 300,
          fromAccountId: bankId,
          toAccountId: expenseId,
          propertyId,
        },
      })) as CallToolResult,
    );
    createdEntryIds.push(res.entryId);

    const rows = parse(
      (await client.callTool({
        name: "query_transactions",
        arguments: { accountId: expenseId },
      })) as CallToolResult,
    );
    const tagged = rows.find((r: any) => r.id === res.entryId);
    expect(tagged.propertyId).toBe(propertyId);
  });

  it("rejects an unknown propertyId", async () => {
    const res = (await client.callTool({
      name: "add_transaction",
      arguments: {
        date: "2026-05-12",
        description: "bad",
        amount: 1,
        fromAccountId: bankId,
        toAccountId: expenseId,
        propertyId: "prop_missing",
      },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});

describe("delete_transaction", () => {
  it("deletes an entry and its postings", async () => {
    const created = parse(
      (await client.callTool({
        name: "add_transaction",
        arguments: {
          date: "2026-05-13",
          description: "TEST to be deleted",
          amount: 10,
          fromAccountId: bankId,
          toAccountId: expenseId,
        },
      })) as CallToolResult,
    );

    const del = parse(
      (await client.callTool({
        name: "delete_transaction",
        arguments: { entryId: created.entryId },
      })) as CallToolResult,
    );
    expect(del.deleted).toBe(created.entryId);
    expect(del.postings).toBe(2);

    expect(await prisma.journalEntry.findUnique({ where: { id: created.entryId } })).toBeNull();
    expect(await prisma.posting.count({ where: { entryId: created.entryId } })).toBe(0);
  });

  it("errors on an unknown entry id", async () => {
    const res = (await client.callTool({
      name: "delete_transaction",
      arguments: { entryId: "je_missing" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});

describe("categorize_transaction", () => {
  const createdRuleIds: string[] = [];

  afterAll(async () => {
    if (createdRuleIds.length) {
      await prisma.rule.deleteMany({ where: { id: { in: createdRuleIds } } });
    }
  });

  async function addEntry(description: string, amount = 10): Promise<string> {
    const res = parse(
      (await client.callTool({
        name: "add_transaction",
        arguments: { date: "2026-06-11", description, amount, fromAccountId: bankId, toAccountId: expenseId },
      })) as CallToolResult,
    );
    createdEntryIds.push(res.entryId);
    return res.entryId;
  }

  it("re-categorizes the category leg and preserves the zero-sum invariant", async () => {
    const entryId = await addEntry("TEST categorize happy path", 50);

    const res = parse(
      (await client.callTool({
        name: "categorize_transaction",
        arguments: { entryId, targetAccountId: expense2Id },
      })) as CallToolResult,
    );
    expect(res.entryId).toBe(entryId);
    expect(res.previousAccountId).toBe(expenseId);
    expect(res.newAccountId).toBe(expense2Id);

    const postings = await prisma.posting.findMany({ where: { entryId } });
    expect(postings.reduce((sum, p) => sum + p.amount, 0)).toBe(0);
    expect(postings.find((p) => p.accountId === expense2Id)?.amount).toBe(5000);
    expect(postings.find((p) => p.accountId === bankId)?.amount).toBe(-5000);
  });

  it("applies a stored categorize rule via ruleId", async () => {
    const rule = await prisma.rule.create({
      data: { id: newId("rule"), pattern: "TEST rule apply", action: "categorize", accountId: expense2Id, priority: 0 },
    });
    createdRuleIds.push(rule.id);

    const entryId = await addEntry("TEST rule apply entry");

    const res = parse(
      (await client.callTool({
        name: "categorize_transaction",
        arguments: { entryId, ruleId: rule.id },
      })) as CallToolResult,
    );
    expect(res.newAccountId).toBe(expense2Id);
    expect(res.appliedRuleId).toBe(rule.id);

    const postings = await prisma.posting.findMany({ where: { entryId } });
    expect(postings.reduce((sum, p) => sum + p.amount, 0)).toBe(0);
  });

  it("sets propertyId on the entry", async () => {
    const entryId = await addEntry("TEST categorize set property", 100);

    await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId, targetAccountId: expense2Id, propertyId },
    });

    const entry = await prisma.journalEntry.findUnique({ where: { id: entryId } });
    expect(entry?.propertyId).toBe(propertyId);
  });

  it("clears propertyId when clearProperty=true", async () => {
    const res = parse(
      (await client.callTool({
        name: "add_transaction",
        arguments: {
          date: "2026-06-11",
          description: "TEST categorize clear property",
          amount: 75,
          fromAccountId: bankId,
          toAccountId: expenseId,
          propertyId,
        },
      })) as CallToolResult,
    );
    createdEntryIds.push(res.entryId);

    await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId: res.entryId, targetAccountId: expense2Id, clearProperty: true },
    });

    const entry = await prisma.journalEntry.findUnique({ where: { id: res.entryId } });
    expect(entry?.propertyId).toBeNull();
  });

  it("errors when neither targetAccountId nor ruleId is supplied", async () => {
    const entryId = await addEntry("TEST categorize no args");
    const res = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("errors when both targetAccountId and ruleId are supplied", async () => {
    const rule = await prisma.rule.create({
      data: { id: newId("rule"), pattern: "TEST both supplied", action: "categorize", accountId: expense2Id, priority: 0 },
    });
    createdRuleIds.push(rule.id);

    const entryId = await addEntry("TEST both supplied");
    const res = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId, targetAccountId: expense2Id, ruleId: rule.id },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("errors on unknown entryId", async () => {
    const res = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId: "je_missing", targetAccountId: expense2Id },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("errors on unknown ruleId", async () => {
    const entryId = await addEntry("TEST unknown ruleId");
    const res = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId, ruleId: "rule_missing" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("errors when ruleId refers to an exclude rule", async () => {
    const rule = await prisma.rule.create({
      data: { id: newId("rule"), pattern: "TEST exclude rule", action: "exclude", accountId: null, priority: 0 },
    });
    createdRuleIds.push(rule.id);

    const entryId = await addEntry("TEST exclude rule entry");
    const res = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId, ruleId: rule.id },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("errors on an entry with no income/expense leg", async () => {
    // Insert a transfer entry directly (two asset legs) — unreachable via add_transaction (rejects same from/to)
    const bank2Id = newId("acc");
    await prisma.account.create({ data: { id: bank2Id, name: `TEST Bank2 ${bank2Id}`, type: "asset" } });
    const entryId = newId("je");
    await prisma.journalEntry.create({
      data: {
        id: entryId,
        date: "2026-06-11",
        description: "TEST two-asset transfer",
        source: "manual",
        postings: {
          create: [
            { id: newId("po"), accountId: bankId, amount: -2000 },
            { id: newId("po"), accountId: bank2Id, amount: 2000 },
          ],
        },
      },
    });
    createdEntryIds.push(entryId);

    const callRes = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId, targetAccountId: expenseId },
    })) as CallToolResult;
    expect(callRes.isError).toBe(true);

    await prisma.posting.deleteMany({ where: { accountId: bank2Id } });
    await prisma.account.delete({ where: { id: bank2Id } });
  });

  it("errors on a split entry (multiple category legs)", async () => {
    const split = parse(
      (await client.callTool({
        name: "split_transaction",
        arguments: {
          date: "2026-06-11",
          description: "TEST split for recategorize",
          paymentAccountId: bankId,
          legs: [
            { accountId: expenseId, amount: 30 },
            { accountId: expense2Id, amount: 20 },
          ],
        },
      })) as CallToolResult,
    );
    createdEntryIds.push(split.entryId);

    const res = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId: split.entryId, targetAccountId: expenseId },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("errors when targetAccountId does not exist", async () => {
    const entryId = await addEntry("TEST unknown targetAccountId");
    const res = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId, targetAccountId: "acc_missing" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("errors when targetAccountId is not an income/expense account", async () => {
    const entryId = await addEntry("TEST wrong account type");
    const res = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId, targetAccountId: bankId },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("errors on unknown propertyId", async () => {
    const entryId = await addEntry("TEST unknown propertyId");
    const res = (await client.callTool({
      name: "categorize_transaction",
      arguments: { entryId, targetAccountId: expense2Id, propertyId: "prop_missing" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
  });
});
