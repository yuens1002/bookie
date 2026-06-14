import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/db/client.js";
import { newId } from "../src/lib/id.js";

// Integration tests against the Neon dev branch. Each test creates its own
// data and cleans up; the seeded chart of accounts is never touched.

let client: Client;
const bankId = newId("acc");
const expenseId = newId("acc");
const createdEntryIds: string[] = [];
const createdReceiptIds: string[] = [];

function parse(res: CallToolResult): any {
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text);
}

async function createEntry(date: string, description: string): Promise<string> {
  const entryId = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: entryId,
      date,
      description,
      source: "manual",
      postings: {
        create: [
          { id: newId("po"), accountId: bankId, amount: -1000 },
          { id: newId("po"), accountId: expenseId, amount: 1000 },
        ],
      },
    },
  });
  createdEntryIds.push(entryId);
  return entryId;
}

beforeAll(async () => {
  await prisma.account.createMany({
    data: [
      { id: bankId, name: `TEST Receipts Bank ${bankId}`, type: "asset" },
      { id: expenseId, name: `TEST Receipts Expense ${expenseId}`, type: "expense" },
    ],
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  client = new Client({ name: "bookie-receipts-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  // Receipts use onDelete: SetNull (not Cascade) — delete explicitly first.
  if (createdReceiptIds.length > 0) {
    await prisma.receipt.deleteMany({ where: { id: { in: createdReceiptIds } } });
  }
  await prisma.journalEntry.deleteMany({ where: { id: { in: createdEntryIds } } });
  await prisma.account.deleteMany({ where: { id: { in: [bankId, expenseId] } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

describe("manage_receipts — attach", () => {
  it("attaches a receipt and returns receiptId + echo fields", async () => {
    const entryId = await createEntry("2026-09-01", "Coffee Shop");

    const res = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: {
          action: "attach",
          entryId,
          merchant: "Blue Bottle Coffee",
          date: "2026-09-01",
          total: 12.5,
        },
      })) as CallToolResult,
    );

    expect(res.receiptId).toMatch(/^rec_/);
    expect(res.entryId).toBe(entryId);
    expect(res.merchant).toBe("Blue Bottle Coffee");
    expect(res.totalMinor).toBe(1250);
    createdReceiptIds.push(res.receiptId as string);
  });

  it("stores lineItems as minor-unit JSON and echoes lineItemCount", async () => {
    const entryId = await createEntry("2026-09-02", "Office Supplies");

    const res = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: {
          action: "attach",
          entryId,
          merchant: "Staples",
          date: "2026-09-02",
          total: 35.0,
          lineItems: [
            { description: "Pens", amount: 5.0, category: "supplies" },
            { description: "Notebooks", amount: 30.0 },
          ],
        },
      })) as CallToolResult,
    );

    expect(res.lineItemCount).toBe(2);
    createdReceiptIds.push(res.receiptId as string);

    // Verify storage by listing
    const list = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "list", entryId },
      })) as CallToolResult,
    );
    expect(list).toHaveLength(1);
    const items = list[0].lineItems as Array<{ description: string; amountMinor: number; category?: string }>;
    expect(items).toHaveLength(2);
    expect(items[0]?.description).toBe("Pens");
    expect(items[0]?.amountMinor).toBe(500);
    expect(items[0]?.category).toBe("supplies");
    expect(items[1]?.amountMinor).toBe(3000);
  });

  it("fails when fileContent is provided without mimeType", async () => {
    const entryId = await createEntry("2026-09-03", "Validation Test A");
    const res = (await client.callTool({
      name: "manage_receipts",
      arguments: { action: "attach", entryId, fileContent: "aGVsbG8=" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/mimeType.*required/i);
  });

  it("fails when mimeType is provided without fileContent", async () => {
    const entryId = await createEntry("2026-09-04", "Validation Test B");
    const res = (await client.callTool({
      name: "manage_receipts",
      arguments: { action: "attach", entryId, mimeType: "image/jpeg" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/fileContent.*required/i);
  });

  it("fails when fileContent is provided but bucket is not configured", async () => {
    // Explicitly clear bucket env vars so this test is deterministic regardless of local/CI environment.
    const saved = {
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_S3_BUCKET_NAME: process.env.AWS_S3_BUCKET_NAME,
    };
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_S3_BUCKET_NAME;
    try {
      const entryId = await createEntry("2026-09-06", "Bucket Not Configured");
      const res = (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "attach", entryId, fileContent: "aGVsbG8=", mimeType: "image/jpeg" },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      const block0 = res.content[0]!;
      expect(block0.type === "text" && block0.text).toMatch(/not configured/i);
    } finally {
      if (saved.AWS_ENDPOINT_URL !== undefined) process.env.AWS_ENDPOINT_URL = saved.AWS_ENDPOINT_URL;
      if (saved.AWS_ACCESS_KEY_ID !== undefined) process.env.AWS_ACCESS_KEY_ID = saved.AWS_ACCESS_KEY_ID;
      if (saved.AWS_SECRET_ACCESS_KEY !== undefined) process.env.AWS_SECRET_ACCESS_KEY = saved.AWS_SECRET_ACCESS_KEY;
      if (saved.AWS_S3_BUCKET_NAME !== undefined) process.env.AWS_S3_BUCKET_NAME = saved.AWS_S3_BUCKET_NAME;
    }
  });

  it("returns hasFile: false and mimeType: null when no file is attached", async () => {
    const entryId = await createEntry("2026-09-05", "No File Receipt");
    const res = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "attach", entryId, merchant: "Cash", date: "2026-09-05", total: 5.0 },
      })) as CallToolResult,
    );
    expect(res.hasFile).toBe(false);
    expect(res.mimeType).toBeNull();
    createdReceiptIds.push(res.receiptId as string);
  });

  it("fails when entryId is missing", async () => {
    const res = (await client.callTool({
      name: "manage_receipts",
      arguments: { action: "attach", merchant: "Nowhere" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/entryId.*required/i);
  });

  it("fails when entryId does not exist", async () => {
    const res = (await client.callTool({
      name: "manage_receipts",
      arguments: { action: "attach", entryId: "je_doesnotexist" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/No journal entry/);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("manage_receipts — list", () => {
  it("filters by entryId and returns only matching receipts", async () => {
    const entryA = await createEntry("2026-09-10", "Entry A");
    const entryB = await createEntry("2026-09-11", "Entry B");

    const resA = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "attach", entryId: entryA, merchant: "Merchant A", date: "2026-09-10" },
      })) as CallToolResult,
    );
    createdReceiptIds.push(resA.receiptId as string);

    const resB = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "attach", entryId: entryB, merchant: "Merchant B", date: "2026-09-11" },
      })) as CallToolResult,
    );
    createdReceiptIds.push(resB.receiptId as string);

    const list = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "list", entryId: entryA },
      })) as CallToolResult,
    );

    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((r: any) => r.entryId === entryA)).toBe(true);
  });

  it("includes hasFile and mimeType on each row", async () => {
    const entryId = await createEntry("2026-09-12", "List Fields Test");
    const attached = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "attach", entryId, merchant: "Fields Check", date: "2026-09-12" },
      })) as CallToolResult,
    );
    createdReceiptIds.push(attached.receiptId as string);

    const list = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "list", entryId },
      })) as CallToolResult,
    ) as any[];

    expect(list).toHaveLength(1);
    expect(list[0]).toHaveProperty("hasFile", false);
    expect(list[0]).toHaveProperty("mimeType", null);
  });

  it("filters by date range", async () => {
    const entryC = await createEntry("2026-09-20", "Entry C");
    const resC = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "attach", entryId: entryC, merchant: "Merchant C", date: "2026-09-20" },
      })) as CallToolResult,
    );
    createdReceiptIds.push(resC.receiptId as string);

    const list = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "list", startDate: "2026-09-20", endDate: "2026-09-20" },
      })) as CallToolResult,
    );

    const found = (list as any[]).some((r) => r.receiptId === resC.receiptId);
    expect(found).toBe(true);
    expect((list as any[]).every((r) => r.date >= "2026-09-20" && r.date <= "2026-09-20")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("manage_receipts — delete", () => {
  it("deletes a receipt and removes it from list", async () => {
    const entryId = await createEntry("2026-09-25", "Delete Me");
    const attached = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "attach", entryId, merchant: "Temporary" },
      })) as CallToolResult,
    );
    const receiptId = attached.receiptId as string;

    const del = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "delete", receiptId },
      })) as CallToolResult,
    );
    expect(del.deleted).toBe(receiptId);
    expect(del.fileDeleted).toBe(false); // receipt has no file

    const list = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "list", entryId },
      })) as CallToolResult,
    );
    expect((list as any[]).some((r) => r.receiptId === receiptId)).toBe(false);
  });

  it("fails when receiptId is missing", async () => {
    const res = (await client.callTool({
      name: "manage_receipts",
      arguments: { action: "delete" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/receiptId.*required/i);
  });

  it("fails when receiptId does not exist", async () => {
    const res = (await client.callTool({
      name: "manage_receipts",
      arguments: { action: "delete", receiptId: "rec_doesnotexist" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/No receipt/);
  });
});

// ---------------------------------------------------------------------------
// get_url
// ---------------------------------------------------------------------------

describe("manage_receipts — get_url", () => {
  it("fails when receiptId is missing", async () => {
    const res = (await client.callTool({
      name: "manage_receipts",
      arguments: { action: "get_url" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/receiptId.*required/i);
  });

  it("fails when receipt has no stored file", async () => {
    const entryId = await createEntry("2026-09-30", "No File Entry");
    const attached = parse(
      (await client.callTool({
        name: "manage_receipts",
        arguments: { action: "attach", entryId, merchant: "No File" },
      })) as CallToolResult,
    );
    createdReceiptIds.push(attached.receiptId as string);

    const res = (await client.callTool({
      name: "manage_receipts",
      arguments: { action: "get_url", receiptId: attached.receiptId },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/no stored file/i);
  });

  it("fails when receipt does not exist", async () => {
    const res = (await client.callTool({
      name: "manage_receipts",
      arguments: { action: "get_url", receiptId: "rec_doesnotexist" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    const block0 = res.content[0]!;
    expect(block0.type === "text" && block0.text).toMatch(/No receipt/);
  });
});
