/**
 * CSV import profiles — declarative column→field maps, one per statement *shape*.
 *
 * Profiles are named by shape, never by a specific bank, so nothing here (or in
 * the generated docs) leaks where the books are kept. A new bank export is a new
 * data entry, not new code: pick the matching `AmountSpec` kind and map columns.
 *
 * The parser (./parse.ts) is generic over these specs — see NormalizedRow.
 */

/**
 * How a row's signed amount is derived. Canonical sign convention for the
 * normalized output is: **positive = money in (deposit/credit), negative =
 * money out (spend/withdrawal/charge)**.
 */
export type AmountSpec =
  /** One signed amount column. `outflow` says which sign means money out. */
  | { kind: "signed"; column: string; outflow: "negative" | "positive" }
  /** Separate debit/credit columns (signs are presentation only — magnitudes
   *  are taken absolute: debit = out, credit = in). Handles both
   *  positive-magnitude and pre-signed-debit exports. */
  | { kind: "debit-credit"; debit: string; credit: string }
  /** A pre-categorized export whose amount sign is unreliable; direction comes
   *  from the category column instead (e.g. "Income" → money in). */
  | { kind: "categorized"; column: string; categoryColumn: string; incomePattern: RegExp };

export interface ProfileSpec {
  /** Neutral, shape-based id (the public-facing profile name). */
  name: string;
  description: string;
  /** Header of the transaction-date column (format auto-detected: ISO or M/D/Y). */
  dateColumn: string;
  /** Headers joined into the entry description (empties skipped). */
  descriptionColumns: string[];
  amount: AmountSpec;
  /** Optional hint columns surfaced for categorization (not used for posting). */
  categoryColumn?: string;
  subCategoryColumn?: string;
  propertyColumn?: string;
}

/**
 * The registry. Keys are the profile names callers pass to `import_transactions`.
 * Column matching is case-insensitive and whitespace-tolerant (see parse.ts), so
 * extra columns (e.g. a check "No." or running "Balance") are simply ignored.
 */
export const PROFILES: Record<string, ProfileSpec> = {
  "signed-amount": {
    name: "signed-amount",
    description:
      "One signed amount column where a negative amount is money out (most checking/debit exports). Columns: Date, Description, Amount.",
    dateColumn: "Date",
    descriptionColumns: ["Description"],
    amount: { kind: "signed", column: "Amount", outflow: "negative" },
  },
  "debit-credit": {
    name: "debit-credit",
    description:
      "Separate Debit and Credit columns (debit = money out, credit = money in); tolerates pre-signed debits. Columns: Date, Description, Debit, Credit. Extra columns are ignored.",
    dateColumn: "Date",
    descriptionColumns: ["Description"],
    amount: { kind: "debit-credit", debit: "Debit", credit: "Credit" },
  },
  "rental-export": {
    name: "rental-export",
    description:
      "A pre-categorized property-management export (RFC-4180: quoted fields, embedded newlines). Amount magnitude is taken absolute; direction comes from the Category column. Category, Sub-Category, and Property are surfaced as categorization hints.",
    dateColumn: "Date",
    descriptionColumns: ["Name"],
    amount: { kind: "categorized", column: "Amount", categoryColumn: "Category", incomePattern: /income/i },
    categoryColumn: "Category",
    subCategoryColumn: "Sub-Category",
    propertyColumn: "Property",
  },
};

export function listProfiles(): string[] {
  return Object.keys(PROFILES);
}
