import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prisma } from "../db/client.js";
import { newId } from "../lib/id.js";
import { toMinor, formatMoney } from "../lib/money.js";
import { ok, fail } from "../lib/result.js";
import { isPrismaCode } from "../lib/prisma.js";
import { blobConfigured, uploadFile, getSignedDownloadUrl, deleteFile } from "../domain/blob.js";

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
        "Attach, list, delete, or retrieve a download URL for receipt data linked to a journal entry. The client LLM extracts merchant, date, total, and line items from a receipt image or text; pass those extracted fields here to store them against an existing entry. Structured data (merchant, date, total, line items) is always stored — no bucket required. File attachment is optional: if the raw file bytes are accessible (e.g. Claude Desktop reading a local file), pass fileContent (base64-encoded, JPEG/PNG/WEBP/HEIC/PDF, practical limit ~500 KB before encoding) + mimeType to upload the file to object storage and receive a signed 1-hour download URL. Both fields are required together; either alone is an error. File storage requires Railway Bucket env vars. Claude.ai mobile clients use vision to extract fields from the receipt image in conversation — in that workflow, call attach with structured fields only and no fileContent. One entry can have multiple receipts.",
      inputSchema: {
        action: z
          .enum(["attach", "list", "delete", "get_url"])
          .describe(
            "attach = link receipt data (and optionally a file) to an entry. list = query receipts by entry or date range. delete = remove a receipt and its stored file. get_url = get a fresh signed download URL for a stored file.",
          ),
        // attach fields
        entryId: z
          .string()
          .optional()
          .describe(
            "(attach) Journal entry id to attach this receipt to (from add_transaction / split_transaction / query_transactions).",
          ),
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
        fileContent: z
          .string()
          .optional()
          .describe(
            "(attach) Base64-encoded receipt file (JPEG, PNG, WEBP, HEIC, or PDF). Must be paired with mimeType. Requires Railway Bucket env vars. Only pass when you have direct access to the file bytes (e.g. Claude Desktop reading a local file). Omit to store structured data only (always valid, no bucket required).",
          ),
        mimeType: z
          .enum(["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"])
          .optional()
          .describe(
            "(attach) MIME type of the file. Required when fileContent is provided; must not be provided without fileContent.",
          ),
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
        // delete / get_url
        receiptId: z.string().optional().describe("(delete / get_url) Receipt id."),
      },
    },
    async (args) => {
      // --- attach ---------------------------------------------------------------
      if (args.action === "attach") {
        if (!args.entryId) return fail("`entryId` is required for action='attach'.");
        if (args.fileContent && !args.mimeType) return fail("`mimeType` is required when `fileContent` is provided.");
        if (!args.fileContent && args.mimeType) return fail("`fileContent` is required when `mimeType` is provided.");
        if (args.fileContent && !blobConfigured())
          return fail("Receipt file storage is not configured. Add the Railway Bucket to this service.");

        const entry = await prisma.journalEntry.findUnique({
          where: { id: args.entryId },
          select: { id: true, date: true, description: true },
        });
        if (!entry)
          return fail(
            `No journal entry with id "${args.entryId}". Use query_transactions to find valid entry ids.`,
          );

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

        let fileKey: string | null = null;
        let fileUrl: string | null = null;

        if (args.fileContent && args.mimeType) {
          const buf = Buffer.from(args.fileContent, "base64");
          fileKey = `receipts/${id}`;
          try {
            await uploadFile(fileKey, buf, args.mimeType);
            fileUrl = await getSignedDownloadUrl(fileKey);
          } catch (err) {
            await deleteFile(fileKey).catch(() => {});
            throw err;
          }
        }

        try {
          await prisma.receipt.create({
            data: {
              id,
              entryId: args.entryId,
              merchant: args.merchant ?? null,
              date: args.date ?? null,
              total: totalMinor,
              lineItems: lineItemsJson,
              fileKey,
              mimeType: fileKey !== null ? (args.mimeType ?? null) : null,
            },
          });
        } catch (err) {
          if (fileKey) await deleteFile(fileKey).catch(() => {});
          throw err;
        }

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
          hasFile: fileKey !== null,
          mimeType: fileKey !== null ? (args.mimeType ?? null) : null,
          ...(fileUrl ? { fileUrl, fileUrlExpiresIn: "1 hour" } : {}),
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
            lineItems: r.lineItems
              ? (() => {
                  try {
                    return JSON.parse(r.lineItems) as unknown[];
                  } catch {
                    return null;
                  }
                })()
              : null,
            hasFile: r.fileKey !== null,
            mimeType: r.mimeType,
            createdAt: r.createdAt.toISOString(),
          })),
        );
      }

      // --- get_url --------------------------------------------------------------
      if (args.action === "get_url") {
        if (!args.receiptId) return fail("`receiptId` is required for action='get_url'.");
        const receipt = await prisma.receipt.findUnique({ where: { id: args.receiptId } });
        if (!receipt) return fail(`No receipt with id "${args.receiptId}".`);
        if (!receipt.fileKey) return fail(`Receipt "${args.receiptId}" has no stored file.`);
        if (!blobConfigured())
          return fail("Receipt file storage is not configured. Add the Railway Bucket to this service.");
        const fileUrl = await getSignedDownloadUrl(receipt.fileKey);
        return ok({ receiptId: args.receiptId, fileUrl, mimeType: receipt.mimeType, fileUrlExpiresIn: "1 hour" });
      }

      // --- delete ---------------------------------------------------------------
      if (!args.receiptId) return fail("`receiptId` is required for action='delete'.");

      const existing = await prisma.receipt.findUnique({ where: { id: args.receiptId } });
      if (!existing) return fail(`No receipt with id "${args.receiptId}".`);

      let fileDeleted = false;
      if (existing.fileKey && blobConfigured()) {
        try {
          await deleteFile(existing.fileKey);
          fileDeleted = true;
        } catch (err) {
          console.error(`blob delete failed for key ${existing.fileKey}:`, err);
        }
      }

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
        fileDeleted,
      });
    },
  );
}
