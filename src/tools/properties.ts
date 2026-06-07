import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../db/client.js";
import { newId } from "../lib/id.js";
import { ok, fail } from "../lib/result.js";
import { isPrismaCode } from "../lib/prisma.js";

export function registerPropertyTools(server: McpServer): void {
  server.registerTool(
    "manage_properties",
    {
      title: "Manage rental properties",
      description:
        "Create, list, or archive rental properties. Schedule E is filed per property, so rental transactions are tagged with a propertyId (and optional unit) in add_transaction. Non-rental work doesn't need properties.",
      inputSchema: {
        action: z.enum(["list", "create", "archive"]),
        name: z.string().optional().describe("Property name/address (required for create)"),
        portfolio: z.string().optional().describe("Optional grouping for multiple properties"),
        id: z.string().optional().describe("Property id (required for archive)"),
        includeArchived: z.boolean().optional(),
      },
    },
    async (args) => {
      switch (args.action) {
        case "list": {
          const rows = await prisma.property.findMany({
            where: args.includeArchived ? {} : { archived: false },
            orderBy: [{ portfolio: "asc" }, { name: "asc" }],
          });
          return ok(rows);
        }
        case "create": {
          if (!args.name) return fail("`name` is required to create a property.");
          const row = await prisma.property.create({
            data: { id: newId("prop"), name: args.name, portfolio: args.portfolio ?? null },
          });
          return ok({ created: row });
        }
        case "archive": {
          if (!args.id) return fail("`id` is required to archive a property.");
          try {
            await prisma.property.update({ where: { id: args.id }, data: { archived: true } });
          } catch (err) {
            if (isPrismaCode(err, "P2025")) return fail(`No property with id "${args.id}".`);
            throw err;
          }
          return ok({ archived: args.id });
        }
      }
    },
  );
}
