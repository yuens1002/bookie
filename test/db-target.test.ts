import { describe, expect, it } from "vitest";
import { normalizeHost, sameDatabase } from "./db-url.js";

// Guards the one invariant that keeps `npm test` from writing to the live ledger:
// test/setup.ts must have substituted the test database for BOOKIE_DB_URL before
// any test file constructed a Prisma client.
//
// The gate throws on a missing or same-database BOOKIE_TEST_DB_URL, but nothing
// asserted the successful path — that the substitution actually took effect.
// Without this, a refactor that dropped the assignment would leave every other
// test passing while silently writing to the real books.

describe("test database target", () => {
  const dbUrl = process.env.BOOKIE_DB_URL;
  const testUrl = process.env.BOOKIE_TEST_DB_URL;

  it("ran through test/setup.ts", () => {
    // Assert presence before parsing so a misconfigured run fails with this
    // message rather than an opaque ERR_INVALID_URL from `new URL(undefined)`.
    expect(testUrl, "BOOKIE_TEST_DB_URL is unset — test/setup.ts did not run").toBeTruthy();
    expect(dbUrl, "BOOKIE_DB_URL is unset — test/setup.ts did not run").toBeTruthy();
  });

  it("has BOOKIE_DB_URL substituted with the test database", () => {
    expect(dbUrl).toBe(testUrl);
    expect(sameDatabase(dbUrl!, testUrl!)).toBe(true);
  });
});

// The guard's whole job is deciding "is this the same database?". It is worth
// testing directly: Neon serves one branch on two hostnames, and treating those
// as different databases would let the live ledger through as a "test" target.

describe("sameDatabase", () => {
  const pooled = "postgresql://u:p@ep-abc-123-pooler.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const direct = "postgresql://u:p@ep-abc-123.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const other = "postgresql://u:p@ep-xyz-999-pooler.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require";

  it("treats the pooled and direct hostnames of one branch as the same database", () => {
    expect(sameDatabase(pooled, direct)).toBe(true);
  });

  it("ignores query-string differences", () => {
    expect(sameDatabase(pooled, `${pooled}&application_name=x`)).toBe(true);
  });

  it("distinguishes different branches", () => {
    expect(sameDatabase(pooled, other)).toBe(false);
  });

  it("distinguishes different databases on one host", () => {
    expect(sameDatabase(pooled, pooled.replace("/neondb", "/otherdb"))).toBe(false);
  });

  it("falls back to exact match on unparseable input", () => {
    expect(sameDatabase("not a url", "not a url")).toBe(true);
    expect(sameDatabase("not a url", "also not a url")).toBe(false);
  });

  it("strips only a trailing -pooler from the first label", () => {
    expect(normalizeHost("ep-abc-pooler.c-3.aws.neon.tech")).toBe("ep-abc.c-3.aws.neon.tech");
    expect(normalizeHost("ep-abc.c-3.aws.neon.tech")).toBe("ep-abc.c-3.aws.neon.tech");
    // a host that merely contains "pooler" mid-label is untouched
    expect(normalizeHost("ep-pooler-abc.c-3.aws.neon.tech")).toBe("ep-pooler-abc.c-3.aws.neon.tech");
  });
});
