import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/db/client.js";
import { newId } from "../src/lib/id.js";
import { matchRule, type RuleSpec } from "../src/domain/import/rules.js";

// --- Pure matcher tests (no DB) ----------------------------------------------

function spec(p: Partial<RuleSpec> & { id: string; pattern: string }): RuleSpec {
  return { action: "categorize", accountId: "acc_x", propertyId: null, priority: 0, ...p };
}

describe("matchRule", () => {
  it("returns null when nothing matches", () => {
    expect(matchRule("COFFEE SHOP", [spec({ id: "r1", pattern: "HARDWARE" })])).toBeNull();
  });

  it("matches case-insensitively on a substring", () => {
    const m = matchRule("POS PURCHASE corner market", [spec({ id: "r1", pattern: "CORNER MARKET" })]);
    expect(m?.ruleId).toBe("r1");
  });

  it("higher priority wins", () => {
    const m = matchRule("HARDWARE STORE", [
      spec({ id: "low", pattern: "HARDWARE", priority: 1, accountId: "acc_low" }),
      spec({ id: "high", pattern: "HARDWARE", priority: 5, accountId: "acc_high" }),
    ]);
    expect(m?.ruleId).toBe("high");
    expect(m?.accountId).toBe("acc_high");
  });

  it("on equal priority, the longer (more specific) pattern wins", () => {
    const m = matchRule("HARDWARE STORE #100", [
      spec({ id: "short", pattern: "HARDWARE" }),
      spec({ id: "long", pattern: "HARDWARE STORE" }),
    ]);
    expect(m?.ruleId).toBe("long");
  });

  it("carries the action and tags (exclude rule)", () => {
    const m = matchRule("ONLINE TRANSFER TO SAVINGS", [
      spec({ id: "x", pattern: "TRANSFER", action: "exclude", accountId: null }),
    ]);
    expect(m).toMatchObject({ action: "exclude", accountId: null });
  });

  it("ignores an empty pattern (never matches-all)", () => {
    expect(matchRule("anything", [spec({ id: "empty", pattern: "" })])).toBeNull();
  });
});

// --- manage_rules tool + import preview integration (live server + DB) --------

let client: Client;
const segmentId = newId("seg");
const expenseId = newId("acc");
const bankId = newId("acc");
const propertyId = newId("prop");
const PFX = `RULETEST_${newId("p")}_`; // unique pattern prefix → isolates this file's rules

function parse(res: CallToolResult): any {
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
const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

beforeAll(async () => {
  await prisma.segment.create({ data: { id: segmentId, name: `TEST Rules Seg ${segmentId}`, taxSchedule: "E" } });
  await prisma.account.createMany({
    data: [
      { id: bankId, name: `TEST Rules Bank ${bankId}`, type: "asset" },
      { id: expenseId, name: `TEST Rules Repairs ${expenseId}`, type: "expense", segmentId },
    ],
  });
  await prisma.property.create({ data: { id: propertyId, name: `TEST Rules Property ${propertyId}` } });

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(st);
  client = new Client({ name: "bookie-rules-test", version: "0.0.0" });
  await client.connect(ct);
});

afterAll(async () => {
  await prisma.rule.deleteMany({ where: { pattern: { startsWith: PFX } } }); // rules FK → accounts, delete first
  // entries (with postings) FK → accounts; remove any that touched the test bank
  const entries = await prisma.journalEntry.findMany({
    where: { postings: { some: { accountId: bankId } } },
    select: { id: true },
  });
  await prisma.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
  await prisma.account.deleteMany({ where: { id: { in: [bankId, expenseId] } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.segment.deleteMany({ where: { id: segmentId } });
  await prisma.$disconnect();
});

describe("manage_rules", () => {
  it("creates a categorize rule (with property), an exclude rule; lists, tests, deletes", async () => {
    const cat = parse(await call("manage_rules", { action: "create", pattern: `${PFX}HARDWARE`, accountId: expenseId, propertyId, priority: 5 }));
    expect(cat.created).toMatchObject({ action: "categorize", accountId: expenseId, propertyId, priority: 5 });

    const exc = parse(await call("manage_rules", { action: "create", pattern: `${PFX}TRANSFER`, ruleAction: "exclude" }));
    expect(exc.created).toMatchObject({ action: "exclude", accountId: null });

    const list = parse(await call("manage_rules", { action: "list" }));
    const mine = list.filter((r: any) => r.pattern.startsWith(PFX));
    expect(mine).toHaveLength(2);

    const tested = parse(await call("manage_rules", { action: "test", description: `bought at ${PFX}HARDWARE store` }));
    expect(tested.match).toMatchObject({ action: "categorize", accountId: expenseId, propertyId });

    const del = parse(await call("manage_rules", { action: "delete", id: exc.created.id }));
    expect(del.deleted).toBe(exc.created.id);
  });

  // every fail() branch in the handler
  it("create without pattern → error", async () => {
    expect(errText(await call("manage_rules", { action: "create", accountId: expenseId }))).toMatch(/`pattern` is required/);
  });
  it("categorize without accountId → error", async () => {
    expect(errText(await call("manage_rules", { action: "create", pattern: `${PFX}X` }))).toMatch(/require an `accountId`/);
  });
  it("categorize with non-existent accountId → error", async () => {
    expect(errText(await call("manage_rules", { action: "create", pattern: `${PFX}X`, accountId: "acc_missing" }))).toMatch(/accountId does not exist/);
  });
  it("exclude with accountId → error", async () => {
    expect(errText(await call("manage_rules", { action: "create", pattern: `${PFX}X`, ruleAction: "exclude", accountId: expenseId }))).toMatch(/must not have an `accountId`/);
  });
  it("exclude with propertyId → error", async () => {
    expect(errText(await call("manage_rules", { action: "create", pattern: `${PFX}X`, ruleAction: "exclude", propertyId }))).toMatch(/must not have a `propertyId`/);
  });
  it("categorize with non-existent propertyId → error", async () => {
    expect(errText(await call("manage_rules", { action: "create", pattern: `${PFX}X`, accountId: expenseId, propertyId: "prop_missing" }))).toMatch(/propertyId does not exist/);
  });
  it("delete without id → error", async () => {
    expect(errText(await call("manage_rules", { action: "delete" }))).toMatch(/`id` is required/);
  });
  it("delete non-existent id → error", async () => {
    expect(errText(await call("manage_rules", { action: "delete", id: "rule_missing" }))).toMatch(/No rule with id/);
  });
  it("test without description → error", async () => {
    expect(errText(await call("manage_rules", { action: "test" }))).toMatch(/`description` is required/);
  });
  it("create with a blank (whitespace-only) pattern → error", async () => {
    expect(errText(await call("manage_rules", { action: "create", pattern: "   ", accountId: expenseId }))).toMatch(/must not be blank/);
  });
});

describe("import_transactions preview — rule suggestions", () => {
  it("attaches a categorize suggestion, an exclude suggestion, and nothing when no rule matches", async () => {
    await call("manage_rules", { action: "create", pattern: `${PFX}COFFEE`, accountId: expenseId, propertyId, priority: 3 });
    await call("manage_rules", { action: "create", pattern: `${PFX}MOVE`, ruleAction: "exclude" });

    const csv = [
      "Date,Description,Amount",
      `2026-10-01,${PFX}COFFEE downtown,-5.00`,
      `2026-10-02,${PFX}MOVE to savings,-100.00`,
      `2026-10-03,unmatched merchant,-9.00`,
    ].join("\n");

    const out = parse(await call("import_transactions", { mode: "preview", profile: "signed-amount", csv, paymentAccountId: bankId }));
    expect(out.rows[0].suggested).toMatchObject({ action: "categorize", accountId: expenseId, propertyId });
    expect(out.rows[1].suggested).toMatchObject({ action: "exclude", accountId: null });
    expect(out.rows[2].suggested).toBeUndefined();
  });

  it("commit never auto-posts from a rule — an unmapped rule-matched row is skipped", async () => {
    await call("manage_rules", { action: "create", pattern: `${PFX}AUTOPOST`, accountId: expenseId, priority: 9 });
    const csv = [
      "Date,Description,Amount",
      `2026-10-05,${PFX}mapped item,-1.00`,
      `2026-10-06,${PFX}AUTOPOST item,-2.00`, // matches the rule, but we give it no mapping
    ].join("\n");
    const out = parse(await call("import_transactions", {
      mode: "commit",
      profile: "signed-amount",
      csv,
      paymentAccountId: bankId,
      mappings: [{ index: 0, targetAccountId: expenseId }], // only row 0
    }));
    expect(out.summary).toMatchObject({ created: 1, skipped: 1 });
    expect(out.skipped).toEqual([1]); // the rule-matched row was NOT auto-created
  });
});
