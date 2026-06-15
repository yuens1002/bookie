/**
 * Dedup + match-or-create planning. Pure functions only — the tool handler reads
 * the existing ledger from Prisma and passes it in, so this stays deterministic
 * and unit-testable without a database.
 *
 * Two safeguards against double-posting an import:
 *  - **External-id dedup**: a content hash per row. Re-importing the same file
 *    reproduces the same ids, so already-imported lines are skipped. Identical
 *    lines *within one file* get distinct ids (occurrence ordinal folded in), so
 *    two genuine same-day/same-amount transactions both import.
 *  - **Possible-match**: a create-candidate whose amount already exists as a
 *    posting on the payment account within a date window is flagged (not merged)
 *    so a receipt-first entry isn't double-posted. The human/LLM decides.
 */
import { createHash } from "node:crypto";
import type { NormalizedRow } from "./parse.js";

export type ImportAction = "create" | "duplicate" | "possible-match";

export interface MatchCandidate {
  entryId: string;
  date: string;
  description: string;
}

export interface PlannedRow extends NormalizedRow {
  externalId: string;
  action: ImportAction;
  /** Set when action = "duplicate": the entry already imported from this line. */
  duplicateOf?: string;
  /** Set when action = "possible-match": existing entries that may be the same. */
  candidates?: MatchCandidate[];
}

/** An existing payment-account posting, joined with its entry, for matching. */
export interface ExistingPosting {
  amount: number; // signed minor units
  entryId: string;
  date: string; // ISO
  description: string;
}

function normDescription(description: string): string {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}

function baseKey(paymentAccountId: string, row: NormalizedRow): string {
  return `${paymentAccountId}|${row.date}|${row.amountMinor}|${normDescription(row.description)}`;
}

/**
 * Deterministic content-hash id per row. Same file → same ids (idempotent
 * re-import); duplicate lines within one file → distinct ids.
 */
export function assignExternalIds(paymentAccountId: string, rows: NormalizedRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = baseKey(paymentAccountId, row);
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    const input = ordinal === 0 ? base : `${base}|#${ordinal}`;
    const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);
    return `imp_${hash}`;
  });
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(a) - Date.parse(b));
  return Math.round(ms / 86_400_000);
}

/**
 * Classify each row as create / duplicate / possible-match. Pure: callers supply
 * the set of already-present external ids and the payment account's existing
 * postings. `paymentAmountFn` maps a row to the amount stored on the payment
 * posting (defaults to `r.amountMinor`; callers that flip signs for liability
 * accounts must pass the negated fn so possible-match queries align).
 */
export function classifyRows(params: {
  rows: NormalizedRow[];
  externalIds: string[];
  existingExternalIds: Set<string>;
  existingPostings: ExistingPosting[];
  windowDays: number;
  paymentAmountFn?: (row: NormalizedRow) => number;
}): PlannedRow[] {
  const { rows, externalIds, existingExternalIds, existingPostings, windowDays, paymentAmountFn } = params;
  const paymentAmount = paymentAmountFn ?? ((r: NormalizedRow) => r.amountMinor);

  return rows.map((row, i) => {
    const externalId = externalIds[i] as string;

    if (existingExternalIds.has(externalId)) {
      return { ...row, externalId, action: "duplicate", duplicateOf: externalId };
    }

    const candidates = existingPostings
      .filter((p) => p.amount === paymentAmount(row) && daysBetween(p.date, row.date) <= windowDays)
      .map((p) => ({ entryId: p.entryId, date: p.date, description: p.description }));

    if (candidates.length > 0) {
      return { ...row, externalId, action: "possible-match", candidates };
    }
    return { ...row, externalId, action: "create" };
  });
}
