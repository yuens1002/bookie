import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../db/client.js";
import { newId } from "../lib/id.js";
import { ok, fail } from "../lib/result.js";
import { isPrismaCode } from "../lib/prisma.js";

export function registerSegmentTools(server: McpServer): void {
  server.registerTool(
    "manage_segments",
    {
      title: "Manage segments",
      description:
        "Create, list, or archive segments — lines of business (or 'Personal'). Each segment is its own P&L and tax filing (Schedule C, Schedule E, or none for personal), but all share one ledger so they combine at year-end. Income/expense accounts belong to a segment; bank/card accounts stay segment-neutral.",
      inputSchema: {
        action: z.enum(["list", "create", "archive"]),
        name: z.string().optional().describe("Segment name, e.g. 'Rental', 'Consulting' (required for create)"),
        taxSchedule: z
          .enum(["C", "E"])
          .optional()
          .describe("US tax form: C = Schedule C (sole prop / gig), E = Schedule E (rental). Omit for personal."),
        id: z.string().optional().describe("Segment id (required for archive)"),
        includeArchived: z.boolean().optional(),
      },
    },
    async (args) => {
      switch (args.action) {
        case "list": {
          const rows = await prisma.segment.findMany({
            where: args.includeArchived ? {} : { archived: false },
            orderBy: { name: "asc" },
          });
          return ok(rows);
        }
        case "create": {
          if (!args.name) return fail("`name` is required to create a segment.");
          try {
            const row = await prisma.segment.create({
              data: { id: newId("seg"), name: args.name, taxSchedule: args.taxSchedule ?? null },
            });
            return ok({ created: row });
          } catch (err) {
            if (isPrismaCode(err, "P2002")) return fail(`A segment named "${args.name}" already exists.`);
            throw err;
          }
        }
        case "archive": {
          if (!args.id) return fail("`id` is required to archive a segment.");
          try {
            await prisma.segment.update({ where: { id: args.id }, data: { archived: true } });
          } catch (err) {
            if (isPrismaCode(err, "P2025")) return fail(`No segment with id "${args.id}".`);
            throw err;
          }
          return ok({ archived: args.id });
        }
      }
    },
  );
}
