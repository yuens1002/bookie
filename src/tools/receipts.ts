import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../db/client.js";
import { newId } from "../lib/id.js";
import { toMinor, formatMoney } from "../lib/money.js";
import { ok, fail } from "../lib/result.js";
import { isPrismaCode } from "../lib/prisma.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const LineItemSchema = z.object({
  description: z.string().min(1).describe("Item name or description"),
  amount: z.number().positive().describe("Item amount in dollars (positive)"),
  category: z.string().optional().describe("Optional category tag for this line item"),
});

export function registerReceiptTools(server: McpServer): void {
  server.registerTool(
    "manage_receipts",
    {
      title: "Manage receipts",
      description:
        "Attach, list, or delete structured receipt data on a journal entry. The client LLM extracts merchant, date, total, and line items from a receipt image or text; pass the extracted fields here to store them against an existing entry. One entry can have multiple receipts (e.g. a paper receipt + an email confirmation).",
      inputSchema: {
        action: z
          .enum(["attach", "list", "delete"])
          .describe(
            "attach = link receipt data to an existing entry. list = query receipts by entry or date range. delete = remove a receipt by id.",
          ),
        // attach fields
        entryId: z
          .string()
          .optional()
          .describe("(attach) Journal entry id to attach this receipt to (from add_transaction / split_transaction / query_transactions)."),
        merchant: z.string().optional().describe("(attach) Merchant or payee name."),
        date: z
          .string()
          .regex(ISO_DATE, "Use ISO date YYYY-MM-DD")
          .optional()
          .describe("(attach) Receipt date (YYYY-MM-DD)."),
        total: z.number().positive().optional().describe("(attach) Receipt total in dollars (positive)."),
        lineItems: z
          .array(LineItemSchema)
          .optional()
          .describe("(attach) Itemized line items extracted from the receipt. Amounts are in dollars."),
        // list fields
        startDate: z
          .string()
          .regex(ISO_DATE)
          .optional()
          .describe("(list) Return receipts with date >= startDate (YYYY-MM-DD)."),
        endDate: z
          .string()
          .regex(ISO_DATE)
          .optional()
          .describe("(list) Return receipts with date <= endDate (YYYY-MM-DD)."),
        // delete fields
        receiptId: z.string().optional().describe("(delete) Receipt id to remove."),
      },
    },
    async (args) => {
      // --- attach ---------------------------------------------------------------
      if (args.action === "attach") {
        if (!args.entryId) return fail("`entryId` is required for action='attach'.");

        const entry = await prisma.journalEntry.findUnique({
          where: { id: args.entryId },
          select: { id: true, date: true, description: true },
        });
        if (!entry) return fail(`No journal entry with id "${args.entryId}". Use query_transactions to find valid entry ids.`);

        const id = newId("rec");
        const totalMinor = args.total !== undefined ? toMinor(args.total) : null;
        const lineItemsJson = args.lineItems
          ? JSON.stringify(
              args.lineItems.map((li) => ({
                description: li.description,
                amountMinor: toMinor(li.amount),
                ...(li.category ? { category: li.category } : {}),
              })),
            )
          : null;

        await prisma.receipt.create({
          data: {
            id,
            entryId: args.entryId,
            merchant: args.merchant ?? null,
            date: args.date ?? null,
            total: totalMinor,
            lineItems: lineItemsJson,
          },
        });

        return ok({
          receiptId: id,
          entryId: args.entryId,
          entryDate: entry.date,
          entryDescription: entry.description,
          merchant: args.merchant ?? null,
          date: args.date ?? null,
          total: totalMinor !== null ? formatMoney(totalMinor) : null,
          totalMinor,
          lineItemCount: args.lineItems?.length ?? 0,
        });
      }

      // --- list -----------------------------------------------------------------
      if (args.action === "list") {
        const receipts = await prisma.receipt.findMany({
          where: {
            ...(args.entryId ? { entryId: args.entryId } : {}),
            ...(args.startDate || args.endDate
              ? {
                  date: {
                    ...(args.startDate ? { gte: args.startDate } : {}),
                    ...(args.endDate ? { lte: args.endDate } : {}),
                  },
                }
              : {}),
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: 100,
        });

        return ok(
          receipts.map((r) => ({
            receiptId: r.id,
            entryId: r.entryId,
            merchant: r.merchant,
            date: r.date,
            total: r.total !== null ? formatMoney(r.total) : null,
            totalMinor: r.total,
            lineItems: r.lineItems ? (() => { try { return JSON.parse(r.lineItems) as unknown[]; } catch { return null; } })() : null,
            createdAt: r.createdAt.toISOString(),
          })),
        );
      }

      // --- delete ---------------------------------------------------------------
      if (!args.receiptId) return fail("`receiptId` is required for action='delete'.");

      const existing = await prisma.receipt.findUnique({ where: { id: args.receiptId } });
      if (!existing) return fail(`No receipt with id "${args.receiptId}".`);

      try {
        await prisma.receipt.delete({ where: { id: args.receiptId } });
      } catch (err) {
        if (isPrismaCode(err, "P2025")) return fail(`No receipt with id "${args.receiptId}".`);
        throw err;
      }

      return ok({
        deleted: args.receiptId,
        entryId: existing.entryId,
        merchant: existing.merchant,
        date: existing.date,
      });
    },
  );
}
