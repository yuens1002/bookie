import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { newId } from "../lib/id.js";
import { ok, fail } from "../lib/result.js";
import { isPrismaCode } from "../lib/prisma.js";

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "manage_accounts",
    {
      title: "Manage accounts",
      description:
        "Create, list, or archive ledger accounts. Income/expense accounts double as spending categories and belong to a segment (which sets the tax form); attach a taxLine for the specific Schedule line. Bank/card (asset/liability) accounts are usually segment-neutral (omit segmentId).",
      inputSchema: {
        action: z.enum(["list", "create", "archive"]),
        name: z.string().optional().describe("Account name (required for create)"),
        type: z
          .enum(["asset", "liability", "equity", "income", "expense"])
          .optional()
          .describe("Account type (required for create)"),
        segmentId: z
          .string()
          .optional()
          .describe("Segment this account belongs to (income/expense accounts). Omit for segment-neutral banking. Use manage_segments → list."),
        taxLine: z
          .string()
          .optional()
          .describe("Tax form line this account reports on, e.g. 'Line 14 — Repairs' (Sch E)"),
        id: z.string().optional().describe("Account id (required for archive)"),
        segmentFilter: z.string().optional().describe("Filter list by segment id"),
        includeArchived: z.boolean().optional(),
      },
    },
    async (args) => {
      switch (args.action) {
        case "list": {
          const where: Prisma.AccountWhereInput = {};
          if (args.type) where.type = args.type;
          if (args.segmentFilter) where.segmentId = args.segmentFilter;
          if (!args.includeArchived) where.archived = false;
          const rows = await prisma.account.findMany({
            where,
            include: { segment: { select: { name: true, taxSchedule: true } } },
            orderBy: [{ type: "asc" }, { name: "asc" }],
          });
          return ok(rows);
        }
        case "create": {
          if (!args.name || !args.type) {
            return fail("`name` and `type` are required to create an account.");
          }
          if ((args.type === "income" || args.type === "expense") && !args.segmentId) {
            return fail("Income/expense accounts are segment-scoped categories — pass a `segmentId` (use manage_segments → list/create).");
          }
          if (args.segmentId) {
            const seg = await prisma.segment.count({ where: { id: args.segmentId, archived: false } });
            if (seg !== 1) return fail("segmentId does not exist or is archived. Use manage_segments → list.");
          }
          const row = await prisma.account.create({
            data: {
              id: newId("acc"),
              name: args.name,
              type: args.type,
              segmentId: args.segmentId ?? null,
              taxLine: args.taxLine ?? null,
            },
          });
          return ok({ created: row });
        }
        case "archive": {
          if (!args.id) return fail("`id` is required to archive an account.");
          try {
            await prisma.account.update({
              where: { id: args.id },
              data: { archived: true },
            });
          } catch (err) {
            if (isPrismaCode(err, "P2025")) return fail(`No account with id "${args.id}".`);
            throw err;
          }
          return ok({ archived: args.id });
        }
      }
    },
  );
}
