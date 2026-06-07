import { ensureDefaultChart } from "../db/seed.js";

/**
 * Shared startup step for both transports: seed the default chart of accounts
 * on first run. Schema itself is managed by Prisma (`npm run db:push`), so a
 * missing-table error here means migrations haven't been applied yet.
 */
export async function bootstrapLedger(): Promise<number> {
  try {
    return await ensureDefaultChart();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2021" || code === "P1001") {
      console.error(
        "bookie: database not ready. Run `npm run db:push` to create the schema, " +
          "and check BOOKIE_DB_URL points at your Neon database.",
      );
    }
    throw err;
  }
}
