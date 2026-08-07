// Shared by test/setup.ts (the fail-closed gate) and test/db-target.test.ts.
// Kept separate so the comparison can be unit-tested without importing setup.ts,
// whose module side effects throw by design.

/**
 * Neon serves the same database on two hostnames — pooled (`ep-x-pooler.…`) and
 * direct (`ep-x.…`). Strip the pooler suffix so a pooled/direct pair is not
 * mistaken for two different databases.
 */
export function normalizeHost(host: string): string {
  const [first = "", ...rest] = host.split(".");
  return [first.replace(/-pooler$/, ""), ...rest].join(".");
}

/**
 * Do two connection strings address the same database?
 *
 * Compares normalized host + path, so neither a differing query string nor the
 * pooled/direct hostname pair can disguise the live ledger as a test database.
 */
export function sameDatabase(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return normalizeHost(x.host) === normalizeHost(y.host) && x.pathname === y.pathname;
  } catch {
    // Unparseable — fall back to exact match rather than silently allowing it.
    return a === b;
  }
}
