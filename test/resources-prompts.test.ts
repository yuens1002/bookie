/**
 * Integration tests for P5 deliverables:
 *   D1 — bookie://accounts and bookie://reports/{year} resources
 *   D2 — monthly-close, categorize-uncategorized, prepare-tax-summary prompts
 *   D3 — manage_rules action='suggest'
 *
 * Uses year 2025 date range to avoid collisions with other test suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/db/client.js";
import { newId } from "../src/lib/id.js";

let client: Client;

// Seed IDs — unique per run to avoid collisions
const segId = newId("seg");
const bankId = newId("acc");
const expenseId = newId("acc");
const incomeId = newId("acc");
const createdEntryIds: string[] = [];

// Unique prefix for any rules we create so we can clean them up
const PFX = `RESTEST_${newId("p")}_`;

function parseText(res: CallToolResult): any {
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text);
}

function errText(res: CallToolResult): string {
  expect(res.isError).toBe(true);
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return block.text;
}

/** Extract the text from a resource content item (both text/markdown and application/json resources). */
function resourceText(
  item: { uri: string; mimeType?: string; text: string } | { uri: string; mimeType?: string; blob: string },
): string {
  if ("text" in item) return item.text;
  throw new Error("expected a text resource content item, got blob");
}

/** Extract the prompt message text, asserting it's a text content block. */
function promptText(content: { type: string; [key: string]: unknown }): string {
  if (content.type !== "text") throw new Error(`expected text content, got ${content.type}`);
  return content["text"] as string;
}

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

beforeAll(async () => {
  // Segment (Sch C so it shows up in reports)
  await prisma.segment.create({
    data: { id: segId, name: `TEST ResPr Seg ${segId}`, taxSchedule: "C" },
  });

  // Accounts
  await prisma.account.createMany({
    data: [
      { id: bankId, name: `TEST ResPr Bank ${bankId}`, type: "asset" },
      { id: expenseId, name: `TEST ResPr Expense ${expenseId}`, type: "expense", segmentId: segId },
      { id: incomeId, name: `TEST ResPr Income ${incomeId}`, type: "income", segmentId: segId },
    ],
  });

  // Two entries with the SAME description to create suggest candidates.
  // Dates use 2026-01 so they remain within the suggest action's 24-month window
  // through at least mid-2028 (gate: seed_date + window_months > today + 12_months).
  for (let i = 0; i < 2; i++) {
    const eid = newId("je");
    await prisma.journalEntry.create({
      data: {
        id: eid,
        date: `2026-01-0${i + 1}`,
        description: `${PFX}GROCERIES`,
        source: "import",
        postings: {
          create: [
            { id: newId("po"), accountId: bankId, amount: -(i + 1) * 1000, cleared: true },
            { id: newId("po"), accountId: expenseId, amount: (i + 1) * 1000 },
          ],
        },
      },
    });
    createdEntryIds.push(eid);
  }

  // One more entry with a unique description (should NOT appear in suggest — only 1 occurrence)
  const singleton = newId("je");
  await prisma.journalEntry.create({
    data: {
      id: singleton,
      date: "2026-01-03",
      description: `${PFX}UNIQUE_MERCHANT`,
      source: "import",
      postings: {
        create: [
          { id: newId("po"), accountId: bankId, amount: -500, cleared: false },
          { id: newId("po"), accountId: expenseId, amount: 500 },
        ],
      },
    },
  });
  createdEntryIds.push(singleton);

  // Wire up client ↔ server
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(st);
  client = new Client({ name: "bookie-resources-prompts-test", version: "0.0.0" });
  await client.connect(ct);
});

afterAll(async () => {
  await prisma.rule.deleteMany({ where: { pattern: { startsWith: PFX } } });
  await prisma.journalEntry.deleteMany({ where: { id: { in: createdEntryIds } } });
  await prisma.account.deleteMany({ where: { id: { in: [bankId, expenseId, incomeId] } } });
  await prisma.segment.deleteMany({ where: { id: segId } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// D1 — Resources
// ---------------------------------------------------------------------------

describe("bookie://accounts resource", () => {
  it("returns contents[0].text that parses as a non-empty accounts array", async () => {
    const result = await client.readResource({ uri: "bookie://accounts" });
    expect(result.contents).toHaveLength(1);
    const item = result.contents[0]!;
    expect(item.mimeType).toBe("application/json");
    const accounts = JSON.parse(resourceText(item));
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThan(0);
    // Each entry has expected shape
    const first = accounts[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("type");
    expect(first).toHaveProperty("balance");
    expect(first).toHaveProperty("balanceMinor");
  });

  it("includes the test accounts created in beforeAll", async () => {
    const result = await client.readResource({ uri: "bookie://accounts" });
    const accounts = JSON.parse(resourceText(result.contents[0]!));
    const ids = accounts.map((a: any) => a.id);
    expect(ids).toContain(bankId);
    expect(ids).toContain(expenseId);
  });
});

describe("bookie://reports/{year} resource", () => {
  it("returns contents[0].text with text/markdown containing Schedule C and Schedule E", async () => {
    const result = await client.readResource({ uri: "bookie://reports/2025" });
    expect(result.contents).toHaveLength(1);
    const item = result.contents[0]!;
    expect(item.mimeType).toBe("text/markdown");
    const text = resourceText(item);
    expect(text).toContain("Schedule C");
    expect(text).toContain("Schedule E");
  });

  it("contains the monthly summary table header", async () => {
    const result = await client.readResource({ uri: "bookie://reports/2025" });
    const text = resourceText(result.contents[0]!);
    expect(text).toContain("Monthly Summary");
    expect(text).toContain("| Month |");
  });

  it("contains all 12 month names in the summary table", async () => {
    const result = await client.readResource({ uri: "bookie://reports/2025" });
    const text = resourceText(result.contents[0]!);
    for (const month of ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"]) {
      expect(text).toContain(month);
    }
  });
});

// ---------------------------------------------------------------------------
// D2 — Prompts
// ---------------------------------------------------------------------------

describe("monthly-close prompt", () => {
  it("returns non-empty messages mentioning import and reconcile", async () => {
    const result = await client.getPrompt({ name: "monthly-close", arguments: { year: "2025", month: "3" } });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    const text = promptText(result.messages[0]!.content);
    expect(text.toLowerCase()).toContain("import");
    expect(text.toLowerCase()).toContain("reconcile");
  });

  it("references the year and month in the message text", async () => {
    const result = await client.getPrompt({ name: "monthly-close", arguments: { year: "2025", month: "3" } });
    const text = promptText(result.messages[0]!.content);
    expect(text).toContain("2025");
  });
});

describe("categorize-uncategorized prompt", () => {
  it("returns non-empty messages mentioning query_transactions and categorize_transaction", async () => {
    const result = await client.getPrompt({ name: "categorize-uncategorized", arguments: {} });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    const text = promptText(result.messages[0]!.content);
    expect(text).toContain("query_transactions");
    expect(text).toContain("categorize_transaction");
  });
});

describe("prepare-tax-summary prompt", () => {
  it("returns non-empty messages mentioning schedule-c and schedule-e", async () => {
    const result = await client.getPrompt({ name: "prepare-tax-summary", arguments: { year: "2025" } });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    const text = promptText(result.messages[0]!.content);
    expect(text.toLowerCase()).toContain("schedule c");
    expect(text.toLowerCase()).toContain("schedule e");
  });

  it("references the requested year", async () => {
    const result = await client.getPrompt({ name: "prepare-tax-summary", arguments: { year: "2025" } });
    const text = promptText(result.messages[0]!.content);
    expect(text).toContain("2025");
  });
});

// ---------------------------------------------------------------------------
// D3 — manage_rules action='suggest'
// ---------------------------------------------------------------------------

describe("manage_rules action='suggest'", () => {
  it("returns ok shape with suggestions array", async () => {
    const res = (await call("manage_rules", { action: "suggest" })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const data = parseText(res);
    expect(data).toHaveProperty("suggestions");
    expect(Array.isArray(data.suggestions)).toBe(true);
  });

  it("includes the repeated description in suggestions (2+ occurrences, no existing rule)", async () => {
    const res = (await call("manage_rules", { action: "suggest" })) as CallToolResult;
    const data = parseText(res);
    const match = data.suggestions.find(
      (s: any) => s.description === `${PFX}GROCERIES`.toLowerCase(),
    );
    expect(match).toBeDefined();
    expect(match.accountId).toBe(expenseId);
    expect(match.occurrences).toBeGreaterThanOrEqual(2);
  });

  it("does NOT include descriptions with only 1 occurrence", async () => {
    const res = (await call("manage_rules", { action: "suggest" })) as CallToolResult;
    const data = parseText(res);
    const match = data.suggestions.find(
      (s: any) => s.description === `${PFX}UNIQUE_MERCHANT`.toLowerCase(),
    );
    expect(match).toBeUndefined();
  });

  it("respects the limit parameter", async () => {
    const res = (await call("manage_rules", { action: "suggest", limit: 1 })) as CallToolResult;
    const data = parseText(res);
    expect(data.suggestions.length).toBeLessThanOrEqual(1);
  });

  it("excludes descriptions already covered by an existing rule", async () => {
    // Create a rule that covers PFX_GROCERIES
    await call("manage_rules", { action: "create", pattern: `${PFX}GROCERIES`, accountId: expenseId });

    const res = (await call("manage_rules", { action: "suggest" })) as CallToolResult;
    const data = parseText(res);
    const match = data.suggestions.find(
      (s: any) => s.description === `${PFX}GROCERIES`.toLowerCase(),
    );
    expect(match).toBeUndefined();
  });

  // Gate 23 — type-scoped param rejection
  it("action='suggest' + accountId → isError: true", async () => {
    const res = (await call("manage_rules", { action: "suggest", accountId: expenseId })) as CallToolResult;
    expect(errText(res)).toMatch(/does not accept/);
  });

  it("action='suggest' + pattern → isError: true", async () => {
    const res = (await call("manage_rules", { action: "suggest", pattern: "COFFEE" })) as CallToolResult;
    expect(errText(res)).toMatch(/does not accept/);
  });

  it("action='suggest' + id → isError: true", async () => {
    const res = (await call("manage_rules", { action: "suggest", id: "rule_123" })) as CallToolResult;
    expect(errText(res)).toMatch(/does not accept/);
  });

  it("action='suggest' + priority → isError: true", async () => {
    const res = (await call("manage_rules", { action: "suggest", priority: 5 })) as CallToolResult;
    expect(errText(res)).toMatch(/does not accept/);
  });
});
