/**
 * Money is stored and computed as integer minor units (cents). Never use
 * floating point for ledger math. Conversions happen only at the edges
 * (tool input/output and report rendering).
 */

/** Major units (e.g. dollars) -> integer minor units (cents). */
export function toMinor(major: number | string): number {
  let n: number;
  if (typeof major === "string") {
    const cleaned = major.replace(/[$,\s]/g, "");
    // An empty/blank amount is ambiguous — reject it rather than treat it as $0.
    if (cleaned === "") {
      throw new Error(`Invalid monetary amount: ${JSON.stringify(major)}`);
    }
    n = Number(cleaned);
  } else {
    n = major;
  }
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid monetary amount: ${JSON.stringify(major)}`);
  }
  return Math.round(n * 100);
}

/** Integer minor units (cents) -> major units (dollars) as a number. */
export function toMajor(minor: number): number {
  return minor / 100;
}

/** Render minor units as a localized currency string, e.g. `$1,234.56`. */
export function formatMoney(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(minor / 100);
}
