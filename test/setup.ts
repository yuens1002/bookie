// Integration tests write real rows (journal entries, postings, receipts, OAuth
// tokens) and only clean up in `afterAll` — an interrupted run leaves them behind.
// So the suite must never point at the live ledger.
//
// BOOKIE_TEST_DB_URL is the test database (the Neon "dev" branch). It overrides
// BOOKIE_DB_URL here, before any test file imports src/db/client.ts, because
// prisma/schema.prisma resolves its datasource from env("BOOKIE_DB_URL") when the
// client is constructed.
//
// Refresh the test branch's schema + data with:
//   npx neonctl branches reset dev --parent
import "dotenv/config";

const testUrl = process.env.BOOKIE_TEST_DB_URL;

if (!testUrl) {
  throw new Error(
    "BOOKIE_TEST_DB_URL is not set — refusing to run tests.\n" +
      "The suite writes to the database, so it must not run against the live ledger.\n" +
      "`npm run setup` does not create a test branch; make one and add it to .env:\n" +
      "  npx neonctl branches create --name test --parent main --project-id <id>\n" +
      "  npx neonctl connection-string test --project-id <id> --pooled   # BOOKIE_TEST_DB_URL\n" +
      "  npx neonctl connection-string test --project-id <id>            # BOOKIE_TEST_DB_DIRECT_URL",
  );
}

/** Same database? Compare host + path so a differing query string can't disguise it. */
function sameDatabase(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return x.host === y.host && x.pathname === y.pathname;
  } catch {
    // Unparseable — fall back to exact match rather than silently allowing it.
    return a === b;
  }
}

const appUrl = process.env.BOOKIE_DB_URL;
if (appUrl && sameDatabase(testUrl, appUrl)) {
  throw new Error(
    "BOOKIE_TEST_DB_URL points at the same database as BOOKIE_DB_URL — refusing to run.\n" +
      "Tests would write to the live ledger. Point it at a separate Neon branch.",
  );
}

process.env.BOOKIE_DB_URL = testUrl;
process.env.BOOKIE_DB_DIRECT_URL = process.env.BOOKIE_TEST_DB_DIRECT_URL ?? testUrl;
