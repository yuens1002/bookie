import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { newId } from "../lib/id.js";
import { toMinor, formatMoney } from "../lib/money.js";
import { ok, fail } from "../lib/result.js";
import { isPrismaCode } from "../lib/prisma.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerTransactionTools(server: McpServer): void {
  // --- add_transaction -------------------------------------------------------
  server.registerTool(
    "add_transaction",
    {
      title: "Add a transaction",
      description:
        "Record a single transaction as a balanced double-entry. Money flows FROM one account TO another: for spending, from your bank/card to an expense account; for income, from an income account to your bank. Amounts are positive, in dollars.",
      inputSchema: {
        date: z.string().regex(ISO_DATE, "Use ISO date YYYY-MM-DD"),
        description: z.string().min(1),
        amount: z.number().positive().describe("Positive amount in dollars"),
        fromAccountId: z
          .string()
          .describe("Source account (credited / decreased) — e.g. your checking for an expense"),
        toAccountId: z
          .string()
          .describe("Destination account (debited / increased) — e.g. an expense category"),
        memo: z.string().optional(),
        externalId: z
          .string()
          .optional()
          .describe("Bank-provided id used to deduplicate imports"),
        propertyId: z
          .string()
          .optional()
          .describe("Rental property this entry belongs to (for Schedule E). Use manage_properties → list."),
      },
    },
    async (args) => {
      if (args.fromAccountId === args.toAccountId) {
        return fail("`fromAccountId` and `toAccountId` must differ.");
      }
      const found = await prisma.account.count({
        where: { id: { in: [args.fromAccountId, args.toAccountId] } },
      });
      if (found !== 2) {
        return fail("One or both account ids do not exist. Use manage_accounts → list.");
      }
      if (args.propertyId) {
        const prop = await prisma.property.count({ where: { id: args.propertyId } });
        if (prop !== 1) {
          return fail("propertyId does not exist. Use manage_properties → list.");
        }
      }

      const minor = toMinor(args.amount);
      const entryId = newId("je");
      try {
        await prisma.journalEntry.create({
          data: {
            id: entryId,
            date: args.date,
            description: args.description,
            memo: args.memo ?? null,
            source: "manual",
            externalId: args.externalId ?? null,
            propertyId: args.propertyId ?? null,
            postings: {
              create: [
                { id: newId("po"), accountId: args.toAccountId, amount: minor },
                { id: newId("po"), accountId: args.fromAccountId, amount: -minor },
              ],
            },
          },
        });
      } catch (err) {
        if (isPrismaCode(err, "P2002")) {
          return fail(`A transaction with externalId "${args.externalId}" already exists (duplicate import).`);
        }
        throw err;
      }

      return ok({
        entryId,
        date: args.date,
        description: args.description,
        amount: formatMoney(minor),
        from: args.fromAccountId,
        to: args.toAccountId,
      });
    },
  );

  // --- split_transaction -----------------------------------------------------
  server.registerTool(
    "split_transaction",
    {
      title: "Add a split transaction",
      description:
        "Record one purchase (or deposit) that splits across multiple categories — e.g. a receipt with both business and personal items. Creates a single balanced journal entry: one leg on the payment account (the bank/card — this is what a statement shows and what reconciliation matches) plus one leg per category. Use this instead of add_transaction when a single statement line maps to several categories. Store the full itemization on the receipt; the legs are per-category roll-ups.",
      inputSchema: {
        date: z.string().regex(ISO_DATE, "Use ISO date YYYY-MM-DD"),
        description: z.string().min(1),
        paymentAccountId: z
          .string()
          .describe("The bank/card account the money moves through — the single leg a statement shows and reconciliation matches"),
        direction: z
          .enum(["expense", "income"])
          .default("expense")
          .describe("expense = a purchase split across expense categories (default); income = a deposit split across income categories"),
        legs: z
          .array(
            z.object({
              accountId: z.string().describe("Category account (expense for a purchase, income for a deposit)"),
              amount: z.number().positive().describe("Positive amount in dollars allocated to this category"),
            }),
          )
          .min(1)
          .describe("Category legs; their amounts sum to the transaction total"),
        memo: z.string().optional(),
        externalId: z.string().optional().describe("Bank-provided id used to deduplicate imports"),
        propertyId: z.string().optional().describe("Rental property (Schedule E). Use manage_properties → list."),
      },
    },
    async (args) => {
      const legAccountIds = args.legs.map((l) => l.accountId);
      if (legAccountIds.includes(args.paymentAccountId)) {
        return fail("paymentAccountId must not also be a category leg.");
      }
      const uniqueIds = [...new Set([args.paymentAccountId, ...legAccountIds])];
      const found = await prisma.account.count({ where: { id: { in: uniqueIds } } });
      if (found !== uniqueIds.length) {
        return fail("One or more account ids do not exist. Use manage_accounts → list.");
      }
      if (args.propertyId) {
        const prop = await prisma.property.count({ where: { id: args.propertyId } });
        if (prop !== 1) {
          return fail("propertyId does not exist. Use manage_properties → list.");
        }
      }

      const legsMinor = args.legs.map((l) => ({ accountId: l.accountId, minor: toMinor(l.amount) }));
      const totalMinor = legsMinor.reduce((sum, l) => sum + l.minor, 0);
      // expense: legs debit (+), payment credit (−total). income: the reverse.
      const legSign = args.direction === "expense" ? 1 : -1;

      const entryId = newId("je");
      try {
        await prisma.journalEntry.create({
          data: {
            id: entryId,
            date: args.date,
            description: args.description,
            memo: args.memo ?? null,
            source: "manual",
            externalId: args.externalId ?? null,
            propertyId: args.propertyId ?? null,
            postings: {
              create: [
                { id: newId("po"), accountId: args.paymentAccountId, amount: -legSign * totalMinor },
                ...legsMinor.map((l) => ({ id: newId("po"), accountId: l.accountId, amount: legSign * l.minor })),
              ],
            },
          },
        });
      } catch (err) {
        if (isPrismaCode(err, "P2002")) {
          return fail(`A transaction with externalId "${args.externalId}" already exists (duplicate import).`);
        }
        throw err;
      }

      return ok({
        entryId,
        date: args.date,
        description: args.description,
        direction: args.direction,
        total: formatMoney(totalMinor),
        paymentAccountId: args.paymentAccountId,
        legs: legsMinor.map((l) => ({ accountId: l.accountId, amount: formatMoney(l.minor) })),
      });
    },
  );

  // --- query_transactions ----------------------------------------------------
  server.registerTool(
    "query_transactions",
    {
      title: "Query transactions",
      description:
        "List journal entries with their postings, filtered by date range and/or account. Returns newest first.",
      inputSchema: {
        startDate: z.string().regex(ISO_DATE).optional(),
        endDate: z.string().regex(ISO_DATE).optional(),
        accountId: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async (args) => {
      const where: Prisma.JournalEntryWhereInput = {};
      if (args.startDate || args.endDate) {
        where.date = {};
        if (args.startDate) where.date.gte = args.startDate;
        if (args.endDate) where.date.lte = args.endDate;
      }
      if (args.accountId) {
        where.postings = { some: { accountId: args.accountId } };
      }

      const entries = await prisma.journalEntry.findMany({
        where,
        include: { postings: true },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: args.limit ?? 50,
      });

      const result = entries.map((e) => ({
        id: e.id,
        date: e.date,
        description: e.description,
        memo: e.memo,
        source: e.source,
        externalId: e.externalId,
        propertyId: e.propertyId,
        postings: e.postings.map((p) => ({
          accountId: p.accountId,
          amount: formatMoney(p.amount),
          amountMinor: p.amount,
        })),
      }));
      return ok(result);
    },
  );

  // --- account_balances ------------------------------------------------------
  server.registerTool(
    "account_balances",
    {
      title: "Account balances",
      description:
        "Compute the current balance of every account (sum of its postings). Optionally filter by segment or as of a date.",
      inputSchema: {
        segmentId: z.string().optional().describe("Filter to one segment's accounts. Use manage_segments → list."),
        asOf: z
          .string()
          .regex(ISO_DATE)
          .optional()
          .describe("Only include postings on entries dated on or before this date"),
      },
    },
    async (args) => {
      const accounts = await prisma.account.findMany({
        where: { archived: false, ...(args.segmentId ? { segmentId: args.segmentId } : {}) },
        include: { segment: { select: { name: true } } },
        orderBy: [{ type: "asc" }, { name: "asc" }],
      });

      const grouped = await prisma.posting.groupBy({
        by: ["accountId"],
        _sum: { amount: true },
        where: args.asOf ? { entry: { date: { lte: args.asOf } } } : undefined,
      });
      const totals = new Map(grouped.map((g) => [g.accountId, g._sum.amount ?? 0]));

      const balances = accounts.map((a) => {
        const minor = totals.get(a.id) ?? 0;
        return {
          id: a.id,
          name: a.name,
          type: a.type,
          segmentId: a.segmentId,
          segment: a.segment?.name ?? null,
          balance: formatMoney(minor),
          balanceMinor: minor,
        };
      });
      return ok(balances);
    },
  );

  // --- categorize_transaction -----------------------------------------------
  server.registerTool(
    "categorize_transaction",
    {
      title: "Re-categorize a transaction",
      description:
        "Change the category account on an existing journal entry — useful for fixing an imported entry posted to the wrong account, or for categorizing an entry that was added without one. Works on simple 2-leg entries (one payment leg + one category leg); for split entries, delete and re-enter with split_transaction. Supply either targetAccountId (explicit) or ruleId (apply a stored categorize rule). Also accepts propertyId / clearProperty to update the entry's rental-property tag.",
      inputSchema: {
        entryId: z.string().describe("Journal entry id (from query_transactions)"),
        targetAccountId: z
          .string()
          .optional()
          .describe(
            "New income/expense account id. Use manage_accounts → list. Required unless ruleId is supplied.",
          ),
        ruleId: z
          .string()
          .optional()
          .describe(
            "Apply a stored categorize rule — its accountId (and propertyId if set) are used. Use manage_rules → list.",
          ),
        propertyId: z
          .string()
          .optional()
          .describe(
            "Set or change the rental property tag on the entry (Schedule E). Overrides a rule's propertyId when both are supplied. Use manage_properties → list.",
          ),
        clearProperty: z
          .boolean()
          .optional()
          .describe("Set to true to remove the property tag from the entry."),
      },
    },
    async (args) => {
      if (!args.targetAccountId && !args.ruleId) {
        return fail("Provide either `targetAccountId` or `ruleId`.");
      }
      if (args.targetAccountId && args.ruleId) {
        return fail("Provide `targetAccountId` or `ruleId`, not both.");
      }

      // Resolve account from rule when ruleId is given.
      let resolvedAccountId: string;
      let rulePropertyId: string | null = null;
      if (args.ruleId) {
        const rule = await prisma.rule.findUnique({ where: { id: args.ruleId } });
        if (!rule) return fail(`No rule with id "${args.ruleId}".`);
        if (rule.action !== "categorize") {
          return fail(
            `Rule "${args.ruleId}" is an exclude rule and has no category account. Use a categorize rule or supply targetAccountId directly.`,
          );
        }
        resolvedAccountId = rule.accountId!;
        rulePropertyId = rule.propertyId;
      } else {
        resolvedAccountId = args.targetAccountId!;
      }

      // Load entry + postings + account types so we can classify legs.
      const entry = await prisma.journalEntry.findUnique({
        where: { id: args.entryId },
        include: { postings: { include: { account: { select: { type: true, name: true } } } } },
      });
      if (!entry) return fail(`No transaction with id "${args.entryId}".`);

      const categoryLegs = entry.postings.filter(
        (p) => p.account.type === "income" || p.account.type === "expense",
      );
      if (categoryLegs.length === 0) {
        return fail("This entry has no income/expense leg to re-categorize.");
      }
      if (categoryLegs.length > 1) {
        return fail(
          "This entry has multiple category legs (a split transaction). Delete it and re-enter with split_transaction.",
        );
      }
      const leg = categoryLegs[0]!;

      // Validate the target account.
      const newAccount = await prisma.account.findUnique({
        where: { id: resolvedAccountId },
        select: { id: true, name: true, type: true },
      });
      if (!newAccount) return fail(`Account "${resolvedAccountId}" does not exist. Use manage_accounts → list.`);
      if (newAccount.type !== "income" && newAccount.type !== "expense") {
        return fail(
          `Account "${newAccount.name}" is type "${newAccount.type}" — categorize_transaction requires an income or expense account.`,
        );
      }

      // Resolve property update: explicit arg > rule's property > no change.
      // null = clear, string = set, undefined = leave as-is.
      const propertyUpdate: string | null | undefined = args.clearProperty
        ? null
        : args.propertyId !== undefined
          ? args.propertyId
          : rulePropertyId !== null
            ? rulePropertyId
            : undefined;

      if (propertyUpdate) {
        const prop = await prisma.property.count({ where: { id: propertyUpdate } });
        if (prop !== 1) return fail("propertyId does not exist. Use manage_properties → list.");
      }

      await prisma.$transaction(async (tx) => {
        await tx.posting.update({ where: { id: leg.id }, data: { accountId: resolvedAccountId } });
        if (propertyUpdate !== undefined) {
          await tx.journalEntry.update({ where: { id: args.entryId }, data: { propertyId: propertyUpdate } });
        }
      });

      return ok({
        entryId: args.entryId,
        date: entry.date,
        description: entry.description,
        previousAccountId: leg.accountId,
        previousAccountName: leg.account.name,
        newAccountId: resolvedAccountId,
        newAccountName: newAccount.name,
        ...(propertyUpdate !== undefined ? { propertyId: propertyUpdate } : {}),
        ...(args.ruleId ? { appliedRuleId: args.ruleId } : {}),
      });
    },
  );

  // --- delete_transaction ----------------------------------------------------
  server.registerTool(
    "delete_transaction",
    {
      title: "Delete a transaction",
      description:
        "Permanently delete a journal entry and its postings (used to correct mistakes or remove duplicate imports). Returns what was deleted. This cannot be undone.",
      inputSchema: {
        entryId: z.string().describe("Journal entry id (from add_transaction or query_transactions)"),
      },
    },
    async (args) => {
      const entry = await prisma.journalEntry.findUnique({
        where: { id: args.entryId },
        include: { postings: true },
      });
      if (!entry) return fail(`No transaction with id "${args.entryId}".`);

      // Postings cascade on entry delete (see schema relation). Handle the race
      // where the entry is deleted between the read above and this delete.
      try {
        await prisma.journalEntry.delete({ where: { id: args.entryId } });
      } catch (err) {
        if (isPrismaCode(err, "P2025")) {
          return fail(`No transaction with id "${args.entryId}".`);
        }
        throw err;
      }
      return ok({
        deleted: entry.id,
        date: entry.date,
        description: entry.description,
        postings: entry.postings.length,
      });
    },
  );
}
