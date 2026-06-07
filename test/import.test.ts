import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/db/client.js";
import { newId } from "../src/lib/id.js";
import { parseCsv } from "../src/domain/import/parse.js";
import { assignExternalIds, classifyRows } from "../src/domain/import/match.js";

function fixture(name: string): string {
  return readFileSync(`examples/csv/${name}`, "utf8");
}

// --- Pure parser + match tests (no DB) ---------------------------------------

describe("parseCsv profiles", () => {
  it("signed-amount: negative = money out, positive = money in", () => {
    const rows = parseCsv(fixture("simple.csv"), "signed-amount");
    expect(rows[0]).toMatchObject({ date: "2026-05-02", description: "Printer paper", amountMinor: -4250 });
    expect(rows[1]).toMatchObject({ amountMinor: 150000 });
  });

  it("debit-credit: debit = out, credit = in (positive-magnitude export)", () => {
    const rows = parseCsv(fixture("generic-debit-credit.csv"), "debit-credit");
    expect(rows[0]).toMatchObject({ description: "Office Depot", amountMinor: -11879 });
    expect(rows[1]).toMatchObject({ amountMinor: 180000 }); // credit
    expect(rows[4]).toMatchObject({ amountMinor: 2410 }); // refund (credit)
  });

  it("debit-credit: handles pre-signed debits and M/D/YYYY dates", () => {
    const rows = parseCsv(fixture("debit-credit-signed.csv"), "debit-credit");
    expect(rows[0]).toMatchObject({ date: "2026-06-03", amountMinor: -4100 });
    expect(rows[3]).toMatchObject({ date: "2026-05-22", amountMinor: 90000 }); // deposit
  });

  it("rental-export: direction from Category (not raw sign); surfaces hints; RFC-4180 safe", () => {
    const rows = parseCsv(fixture("rental-export.csv"), "rental-export");
    expect(rows).toHaveLength(5); // embedded newline did not split a row
    // raw 16.40 is positive in the file but Category is an expense → money out
    expect(rows[0]).toMatchObject({ amountMinor: -1640, rawCategory: "Repairs & Maintenance", rawProperty: "123 Example St" });
    expect(rows[2]).toMatchObject({ amountMinor: -1022, rawCategory: "Admin & Other / Mileage" });
    expect(rows[3]).toMatchObject({ amountMinor: 270000, rawCategory: "Income" }); // income → money in
    expect(rows[4]!.description).toContain('"Special"'); // doubled-quote escape parsed
  });

  it("rejects an unknown profile and a malformed date", () => {
    expect(() => parseCsv("Date,Description,Amount\n", "nope")).toThrow(/Unknown profile/);
    expect(() => parseCsv("Date,Description,Amount\nnot-a-date,X,-1.00\n", "signed-amount")).toThrow(/date/i);
  });

  it("rejects an impossible calendar date that matches the shape", () => {
    expect(() => parseCsv("Date,Description,Amount\n13/40/2026,X,-1.00\n", "signed-amount")).toThrow(/impossible date/i);
    expect(() => parseCsv("Date,Description,Amount\n2026-99-99,X,-1.00\n", "signed-amount")).toThrow(/impossible date/i);
  });

  it("rejects a debit-credit row with neither or both columns filled", () => {
    expect(() => parseCsv("Date,Description,Debit,Credit\n2026-01-01,X,,\n", "debit-credit")).toThrow(/empty or zero/i);
    expect(() => parseCsv("Date,Description,Debit,Credit\n2026-01-01,X,10.00,5.00\n", "debit-credit")).toThrow(/ambiguous/i);
  });
});

describe("assignExternalIds", () => {
  it("is deterministic and gives identical lines within one file distinct ids", () => {
    const rows = parseCsv("Date,Description,Amount\n2026-07-01,Coffee,-5.00\n2026-07-01,Coffee,-5.00\n", "signed-amount");
    const a = assignExternalIds("acc_x", rows);
    const b = assignExternalIds("acc_x", rows);
    expect(a).toEqual(b); // deterministic
    expect(a[0]).not.toEqual(a[1]); // duplicate line → distinct id
    expect(assignExternalIds("acc_y", rows)[0]).not.toEqual(a[0]); // account scopes the id
  });
});

describe("classifyRows", () => {
  const rows = parseCsv("Date,Description,Amount\n2026-07-01,A,-10.00\n2026-07-02,B,-20.00\n", "signed-amount");
  const externalIds = assignExternalIds("acc_x", rows);

  it("flags duplicates by external id", () => {
    const planned = classifyRows({
      rows,
      externalIds,
      existingExternalIds: new Set([externalIds[0]!]),
      existingPostings: [],
      windowDays: 4,
    });
    expect(planned[0]!.action).toBe("duplicate");
    expect(planned[1]!.action).toBe("create");
  });

  it("flags a possible match on equal amount within the date window", () => {
    const planned = classifyRows({
      rows,
      externalIds,
      existingExternalIds: new Set(),
      existingPostings: [{ amount: -2000, entryId: "je_old", date: "2026-07-04", description: "old B" }],
      windowDays: 4,
    });
    expect(planned[1]!.action).toBe("possible-match");
    expect(planned[1]!.candidates?.[0]?.entryId).toBe("je_old");
    expect(planned[0]!.action).toBe("create"); // amount differs
  });
});

// --- Integration: import_transactions over the live server + DB --------------

let client: Client;
const segmentId = newId("seg");
const bankId = newId("acc");
const expenseId = newId("acc");
const incomeId = newId("acc");
const cardId = newId("acc"); // liability — for posting-direction coverage

function parse(res: CallToolResult): any {
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text);
}

/** Raw error text from a failed (isError) tool result. */
function errText(res: CallToolResult): string {
  expect(res.isError).toBe(true);
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return block.text;
}

const CSV = [
  "Date,Description,Amount",
  "2026-07-01,IMPORT TEST Office Supplies,-50.00",
  "2026-07-02,IMPORT TEST Client Deposit,200.00",
].join("\n");

beforeAll(async () => {
  await prisma.segment.create({ data: { id: segmentId, name: `TEST Import Seg ${segmentId}`, taxSchedule: "C" } });
  await prisma.account.createMany({
    data: [
      { id: bankId, name: `TEST Import Bank ${bankId}`, type: "asset" },
      { id: expenseId, name: `TEST Import Supplies ${expenseId}`, type: "expense", segmentId },
      { id: incomeId, name: `TEST Import Revenue ${incomeId}`, type: "income", segmentId },
      { id: cardId, name: `TEST Import Card ${cardId}`, type: "liability" },
    ],
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  client = new Client({ name: "bookie-import-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  // Remove every entry that touched a test payment account (cascades its postings).
  const entries = await prisma.journalEntry.findMany({
    where: { postings: { some: { accountId: { in: [bankId, cardId] } } } },
    select: { id: true },
  });
  await prisma.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
  await prisma.account.deleteMany({ where: { id: { in: [bankId, expenseId, incomeId, cardId] } } });
  await prisma.segment.deleteMany({ where: { id: segmentId } });
  await prisma.$disconnect();
});

describe("import_transactions", () => {
  it("preview parses and classifies but writes nothing", async () => {
    const res = await client.callTool({
      name: "import_transactions",
      arguments: { mode: "preview", profile: "signed-amount", csv: CSV, paymentAccountId: bankId },
    });
    const out = parse(res as CallToolResult);
    expect(out.mode).toBe("preview");
    expect(out.summary).toMatchObject({ total: 2, create: 2 });
    expect(out.rows[0].direction).toBe("out");
    expect(out.rows[1].direction).toBe("in");

    // No writes: the fresh bank account still has no entries.
    const q = parse((await client.callTool({
      name: "query_transactions",
      arguments: { accountId: bankId },
    })) as CallToolResult);
    expect(q).toHaveLength(0);
  });

  it("commit writes balanced double-entry transactions", async () => {
    const res = await client.callTool({
      name: "import_transactions",
      arguments: {
        mode: "commit",
        profile: "signed-amount",
        csv: CSV,
        paymentAccountId: bankId,
        mappings: [
          { index: 0, targetAccountId: expenseId },
          { index: 1, targetAccountId: incomeId },
        ],
      },
    });
    const out = parse(res as CallToolResult);
    expect(out.summary).toMatchObject({ created: 2, duplicates: 0, skipped: 0 });

    const entries = parse((await client.callTool({
      name: "query_transactions",
      arguments: { accountId: bankId },
    })) as CallToolResult);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.source).toBe("import");
      const sum = e.postings.reduce((s: number, p: any) => s + p.amountMinor, 0);
      expect(sum).toBe(0); // balanced
    }
    // Payment leg on the bank account carries the signed statement amount.
    const bankLegs = entries.flatMap((e: any) => e.postings).filter((p: any) => p.accountId === bankId);
    expect(bankLegs.map((p: any) => p.amountMinor).sort((a: number, b: number) => a - b)).toEqual([-5000, 20000]);
  });

  it("re-importing the same statement dedupes (creates nothing)", async () => {
    const res = await client.callTool({
      name: "import_transactions",
      arguments: {
        mode: "commit",
        profile: "signed-amount",
        csv: CSV,
        paymentAccountId: bankId,
        mappings: [
          { index: 0, targetAccountId: expenseId },
          { index: 1, targetAccountId: incomeId },
        ],
      },
    });
    const out = parse(res as CallToolResult);
    expect(out.summary).toMatchObject({ created: 0, duplicates: 2 });

    const entries = parse((await client.callTool({
      name: "query_transactions",
      arguments: { accountId: bankId },
    })) as CallToolResult);
    expect(entries).toHaveLength(2); // still just the two from the first import
  });
});

describe("import_transactions — posting direction & skips", () => {
  // A card (liability) statement, parsed via the debit-credit profile (the BECU
  // shape). A charge must CREDIT the liability (increase what's owed); a payment
  // must DEBIT it. Unique amounts keep this isolated from other tests' dedup.
  const CARD_CSV = [
    "Date,Description,Debit,Credit",
    "2026-09-01,IMPORT TEST Card Charge,33.33,",
    "2026-09-05,IMPORT TEST Card Payment,,33.33",
  ].join("\n");

  it("posts a liability charge as a credit and a payment as a debit", async () => {
    const res = await client.callTool({
      name: "import_transactions",
      arguments: {
        mode: "commit",
        profile: "debit-credit",
        csv: CARD_CSV,
        paymentAccountId: cardId,
        mappings: [
          { index: 0, targetAccountId: expenseId }, // charge → expense
          { index: 1, targetAccountId: bankId }, // payment came from the bank
        ],
      },
    });
    expect(parse(res as CallToolResult).summary).toMatchObject({ created: 2 });

    const entries = parse((await client.callTool({
      name: "query_transactions",
      arguments: { accountId: cardId },
    })) as CallToolResult);
    const cardLegs = entries
      .flatMap((e: any) => e.postings)
      .filter((p: any) => p.accountId === cardId)
      .map((p: any) => p.amountMinor)
      .sort((a: number, b: number) => a - b);
    // charge -3333 (credit → liability up), payment +3333 (debit → liability down)
    expect(cardLegs).toEqual([-3333, 3333]);
    for (const e of entries) {
      expect(e.postings.reduce((s: number, p: any) => s + p.amountMinor, 0)).toBe(0);
    }
  });

  it("skips rows that have no mapping (reported, not written)", async () => {
    const csv = ["Date,Description,Amount", "2026-09-10,IMPORT TEST Mapped,-11.11", "2026-09-11,IMPORT TEST Unmapped,-22.22"].join("\n");
    const res = await client.callTool({
      name: "import_transactions",
      arguments: {
        mode: "commit",
        profile: "signed-amount",
        csv,
        paymentAccountId: bankId,
        mappings: [{ index: 0, targetAccountId: expenseId }],
      },
    });
    const out = parse(res as CallToolResult);
    expect(out.summary).toMatchObject({ created: 1, skipped: 1 });
    expect(out.skipped).toEqual([1]);
  });

  it("flags a possible match through the tool when an amount+date already exists", async () => {
    // Seed an entry on the bank, then preview a near-date row of the same amount.
    await prisma.journalEntry.create({
      data: {
        id: newId("je"),
        date: "2026-09-20",
        description: "IMPORT TEST Pre-existing",
        source: "manual",
        postings: {
          create: [
            { id: newId("po"), accountId: bankId, amount: -9999 },
            { id: newId("po"), accountId: expenseId, amount: 9999 },
          ],
        },
      },
    });
    const csv = ["Date,Description,Amount", "2026-09-21,IMPORT TEST Different Desc,-99.99"].join("\n");
    const out = parse((await client.callTool({
      name: "import_transactions",
      arguments: { mode: "preview", profile: "signed-amount", csv, paymentAccountId: bankId },
    })) as CallToolResult);
    expect(out.summary.possibleMatch).toBe(1);
    expect(out.rows[0].action).toBe("possible-match");
    expect(out.rows[0].candidates).toHaveLength(1);
  });
});

describe("import_transactions — validation errors", () => {
  const CSV2 = "Date,Description,Amount\n2026-07-01,X,-1.00\n";

  it("rejects a non-existent payment account", async () => {
    const res = (await client.callTool({
      name: "import_transactions",
      arguments: { mode: "preview", profile: "signed-amount", csv: CSV2, paymentAccountId: "acc_missing" },
    })) as CallToolResult;
    expect(errText(res)).toMatch(/paymentAccountId does not exist/);
  });

  it("reports a parse failure with the offending row", async () => {
    const res = (await client.callTool({
      name: "import_transactions",
      arguments: { mode: "preview", profile: "signed-amount", csv: "Date,Description,Amount\nnope,X,-1.00\n", paymentAccountId: bankId },
    })) as CallToolResult;
    expect(errText(res)).toMatch(/CSV parse failed/i);
  });

  it("rejects a header-only CSV", async () => {
    const res = (await client.callTool({
      name: "import_transactions",
      arguments: { mode: "preview", profile: "signed-amount", csv: "Date,Description,Amount\n", paymentAccountId: bankId },
    })) as CallToolResult;
    expect(errText(res)).toMatch(/No data rows/i);
  });

  it("rejects commit without mappings", async () => {
    const res = (await client.callTool({
      name: "import_transactions",
      arguments: { mode: "commit", profile: "signed-amount", csv: CSV2, paymentAccountId: bankId },
    })) as CallToolResult;
    expect(errText(res)).toMatch(/requires `mappings`/);
  });

  it("rejects an out-of-range mapping index", async () => {
    const res = (await client.callTool({
      name: "import_transactions",
      arguments: { mode: "commit", profile: "signed-amount", csv: CSV2, paymentAccountId: bankId, mappings: [{ index: 5, targetAccountId: expenseId }] },
    })) as CallToolResult;
    expect(errText(res)).toMatch(/out of range/);
  });

  it("rejects a target equal to the payment account", async () => {
    const res = (await client.callTool({
      name: "import_transactions",
      arguments: { mode: "commit", profile: "signed-amount", csv: CSV2, paymentAccountId: bankId, mappings: [{ index: 0, targetAccountId: bankId }] },
    })) as CallToolResult;
    expect(errText(res)).toMatch(/must differ/);
  });

  it("rejects a non-existent target account", async () => {
    const res = (await client.callTool({
      name: "import_transactions",
      arguments: { mode: "commit", profile: "signed-amount", csv: CSV2, paymentAccountId: bankId, mappings: [{ index: 0, targetAccountId: "acc_missing" }] },
    })) as CallToolResult;
    expect(errText(res)).toMatch(/targetAccountId values do not exist/);
  });

  it("rejects a non-existent property", async () => {
    const res = (await client.callTool({
      name: "import_transactions",
      arguments: { mode: "commit", profile: "signed-amount", csv: CSV2, paymentAccountId: bankId, mappings: [{ index: 0, targetAccountId: expenseId, propertyId: "prop_missing" }] },
    })) as CallToolResult;
    expect(errText(res)).toMatch(/propertyId values do not exist/);
  });

  it("rejects duplicate mapping indices", async () => {
    const res = (await client.callTool({
      name: "import_transactions",
      arguments: {
        mode: "commit",
        profile: "signed-amount",
        csv: CSV2,
        paymentAccountId: bankId,
        mappings: [
          { index: 0, targetAccountId: expenseId },
          { index: 0, targetAccountId: incomeId },
        ],
      },
    })) as CallToolResult;
    expect(errText(res)).toMatch(/Duplicate mapping/);
  });
});
