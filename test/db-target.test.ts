import { describe, expect, it } from "vitest";

// Guards the one invariant that keeps `npm test` from writing to the live ledger:
// test/setup.ts must have redirected BOOKIE_DB_URL at the test database before any
// test file constructed a Prisma client.
//
// The gate in setup.ts throws on a missing or identical BOOKIE_TEST_DB_URL, but
// nothing asserted the successful path — that the override actually took effect.
// Without this, a refactor that dropped the assignment would leave every other
// test passing while silently writing to the real books.

describe("test database target", () => {
  const dbUrl = process.env.BOOKIE_DB_URL;
  const testUrl = process.env.BOOKIE_TEST_DB_URL;

  it("has BOOKIE_DB_URL pointing at the test database", () => {
    expect(testUrl, "BOOKIE_TEST_DB_URL should be set — setup.ts would have thrown").toBeTruthy();
    expect(dbUrl).toBe(testUrl);
  });

  it("is not pointing at a database that setup.ts left unredirected", () => {
    // setup.ts overwrites BOOKIE_DB_URL in place, so by the time any test runs the
    // two must be the same host+path. A mismatch means the override didn't happen.
    const [a, b] = [new URL(dbUrl!), new URL(testUrl!)];
    expect(`${a.host}${a.pathname}`).toBe(`${b.host}${b.pathname}`);
  });
});
