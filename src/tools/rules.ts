import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../db/client.js";
import { newId } from "../lib/id.js";
import { ok, fail } from "../lib/result.js";
import { isPrismaCode } from "../lib/prisma.js";
import { matchRule, type RuleSpec } from "../domain/import/rules.js";

/**
 * Load all rules as pure RuleSpecs, ordered so `matchRule`'s stable sort resolves
 * full ties by oldest-first. Shared by `manage_rules` (test) and the import preview
 * so the matching input is identical in both places.
 */
export async function loadRuleSpecs(): Promise<RuleSpec[]> {
  const rows = await prisma.rule.findMany({ orderBy: [{ priority: "desc" }, { createdAt: "asc" }] });
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    action: r.action,
    accountId: r.accountId,
    propertyId: r.propertyId,
    priority: r.priority,
  }));
}

export function registerRuleTools(server: McpServer): void {
  server.registerTool(
    "manage_rules",
    {
      title: "Manage categorization rules",
      description:
        "Create, list, delete, test, or get suggestions for auto-categorization rules. A rule matches a case-insensitive substring of a transaction's description and either routes it to a category account (action=categorize, optionally tagging a rental property) or marks it to skip on import (action=exclude — e.g. transfers between your own accounts). Higher priority wins; ties break on longer pattern. These rules power the suggestions shown by import_transactions preview. action=suggest scans past categorizations and returns candidate rules for descriptions with 2+ occurrences that have no existing rule.",
      inputSchema: {
        action: z.enum(["list", "create", "delete", "test", "suggest"]),
        pattern: z
          .string()
          .min(1)
          .optional()
          .describe("Case-insensitive substring matched against the description (required for create)"),
        ruleAction: z
          .enum(["categorize", "exclude"])
          .optional()
          .describe("What a matched line does: categorize (needs accountId) or exclude (skip on import). Default categorize."),
        accountId: z
          .string()
          .optional()
          .describe("Target category account — required when ruleAction=categorize; omit for exclude. Use manage_accounts → list."),
        propertyId: z
          .string()
          .optional()
          .describe("Rental property to tag matched entries (Schedule E). categorize only. Use manage_properties → list."),
        priority: z.number().int().optional().describe("Higher wins on conflicting matches (default 0)."),
        id: z.string().optional().describe("Rule id (required for delete)"),
        description: z
          .string()
          .optional()
          .describe("Sample transaction description to test against the rules (required for test)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of suggestions to return (suggest only, default 20)."),
      },
    },
    async (args) => {
      switch (args.action) {
        case "list": {
          const rows = await prisma.rule.findMany({
            orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
            include: { account: { select: { name: true } }, property: { select: { name: true } } },
          });
          return ok(rows);
        }
        case "create": {
          const pattern = args.pattern?.trim();
          if (!pattern) return fail("`pattern` is required to create a rule (and must not be blank).");
          const ruleAction = args.ruleAction ?? "categorize";
          if (ruleAction === "categorize") {
            if (!args.accountId) {
              return fail("categorize rules require an `accountId`. Use manage_accounts → list.");
            }
            const acc = await prisma.account.count({ where: { id: args.accountId } });
            if (acc !== 1) return fail("accountId does not exist. Use manage_accounts → list.");
          } else {
            if (args.accountId) return fail("exclude rules must not have an `accountId` (the line is skipped, not posted).");
            if (args.propertyId) return fail("exclude rules must not have a `propertyId` (nothing is posted to tag).");
          }
          if (args.propertyId) {
            const prop = await prisma.property.count({ where: { id: args.propertyId } });
            if (prop !== 1) return fail("propertyId does not exist. Use manage_properties → list.");
          }
          const row = await prisma.rule.create({
            data: {
              id: newId("rule"),
              pattern,
              action: ruleAction,
              accountId: ruleAction === "categorize" ? args.accountId! : null,
              propertyId: args.propertyId ?? null,
              priority: args.priority ?? 0,
            },
          });
          return ok({ created: row });
        }
        case "delete": {
          if (!args.id) return fail("`id` is required to delete a rule.");
          try {
            await prisma.rule.delete({ where: { id: args.id } });
          } catch (err) {
            if (isPrismaCode(err, "P2025")) return fail(`No rule with id "${args.id}".`);
            throw err;
          }
          return ok({ deleted: args.id });
        }
        case "test": {
          if (!args.description) return fail("`description` is required to test a rule match.");
          const match = matchRule(args.description, await loadRuleSpecs());
          return ok({ description: args.description, match });
        }
        case "suggest": {
          // Gate 23: type-scoped param rejection — suggest is a read-only scan action
          if (args.accountId) return fail("action='suggest' does not accept `accountId` — use action='create' to add a rule.");
          if (args.pattern) return fail("action='suggest' does not accept `pattern` — suggestions are derived from past categorizations.");
          if (args.id) return fail("action='suggest' does not accept `id`.");
          if (args.priority != null) return fail("action='suggest' does not accept `priority`.");

          const limit = args.limit ?? 20;

          // Fetch all income/expense postings with their entry descriptions and account info.
          // Group by normalized description + accountId to find repeated categorizations.
          const postings = await prisma.posting.findMany({
            where: {
              account: { type: { in: ["income", "expense"] } },
            },
            select: {
              accountId: true,
              account: { select: { name: true } },
              entry: { select: { description: true } },
            },
          });

          // Group: normalized description → accountId → count
          type DescKey = string; // normalized description
          type AccKey = string;  // accountId
          const groups = new Map<DescKey, Map<AccKey, { accountName: string; count: number }>>();

          for (const p of postings) {
            const norm = p.entry.description.toLowerCase().replace(/\s+/g, " ").trim();
            if (!norm) continue;
            if (!groups.has(norm)) groups.set(norm, new Map());
            const accMap = groups.get(norm)!;
            const existing = accMap.get(p.accountId);
            if (existing) {
              existing.count++;
            } else {
              accMap.set(p.accountId, { accountName: p.account.name, count: 1 });
            }
          }

          // Load existing rules for de-duplication check (case-insensitive substring)
          const existingRules = await prisma.rule.findMany({ select: { pattern: true } });
          const existingPatterns = existingRules.map((r) => r.pattern.toLowerCase());

          // Build candidate list: desc appears 2+ times with same account, no existing rule substring-matches it
          const candidates: {
            description: string;
            accountId: string;
            accountName: string;
            occurrences: number;
          }[] = [];

          for (const [desc, accMap] of groups) {
            for (const [accountId, { accountName, count }] of accMap) {
              if (count < 2) continue;
              // Check that no existing rule pattern is a substring of this description
              const alreadyCovered = existingPatterns.some((pat) => pat.length > 0 && desc.includes(pat));
              if (alreadyCovered) continue;
              candidates.push({ description: desc, accountId, accountName, occurrences: count });
            }
          }

          // Sort by occurrences descending, limit
          candidates.sort((a, b) => b.occurrences - a.occurrences);
          return ok({ suggestions: candidates.slice(0, limit) });
        }
      }
    },
  );
}
