import { PrismaClient } from "@prisma/client";

/**
 * ONE ledger, shared by every instance. Point all instances at the same
 * database via BOOKIE_DB_URL (a Neon Postgres connection string). The local
 * stdio server and the deployed HTTP server use the same value, so the books
 * are always identical — there is no local copy.
 *
 * Schema is managed by Prisma (`npm run db:push`), not bootstrapped at runtime.
 */
export const prisma = new PrismaClient();
