/**
 * Deterministic CSV → normalized-row pipeline (no DB, no money math beyond the
 * one allowed converter in lib/money.ts). The tool handler in src/tools/import.ts
 * stays thin and calls into here.
 */
import { parse } from "csv-parse/sync";
import { toMinor } from "../../lib/money.js";
import { PROFILES, listProfiles, type ProfileSpec } from "./profiles.js";

/**
 * A statement line normalized to the ledger's conventions. `amountMinor` is
 * signed cents: **positive = money in, negative = money out**. Hint fields are
 * populated only by pre-categorized exports.
 */
export interface NormalizedRow {
  index: number; // 0-based position in the file, used to map confirm-time edits back
  date: string; // ISO YYYY-MM-DD
  description: string;
  amountMinor: number; // signed minor units (+ in / − out)
  rawCategory?: string; // categorization hint, e.g. "Repairs & Maintenance / Supplies"
  rawProperty?: string; // property hint from the export
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Normalize a date cell to ISO YYYY-MM-DD. Throws (with row context) on junk. */
function toIsoDate(raw: string, index: number): string {
  const t = raw.trim();
  if (ISO.test(t)) return t;
  const m = MDY.exec(t);
  if (m) {
    const [, mo, d, y] = m as unknown as [string, string, string, string];
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  throw new Error(`Row ${index + 1}: unrecognized date "${raw}" (expected YYYY-MM-DD or M/D/YYYY).`);
}

/**
 * Case-insensitive, whitespace-tolerant column lookup. Real exports drift on
 * header casing and trailing spaces; we don't want a profile to break over that.
 * Returns "" for an absent column (callers decide if that's an error).
 */
function pick(record: Record<string, string>, header: string): string {
  const want = header.trim().toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.trim().toLowerCase() === want) return (record[key] ?? "").trim();
  }
  return "";
}

/** Empty cell → 0 cents; otherwise convert via the one allowed money helper. */
function minorOrZero(raw: string): number {
  return raw.trim() === "" ? 0 : toMinor(raw);
}

/** Convert a cell that must be present; rethrow with row context on failure. */
function requireMinor(raw: string, index: number, column: string): number {
  try {
    return toMinor(raw);
  } catch {
    throw new Error(`Row ${index + 1}: invalid amount "${raw}" in column "${column}".`);
  }
}

function amountOf(record: Record<string, string>, profile: ProfileSpec, index: number): number {
  const spec = profile.amount;
  switch (spec.kind) {
    case "signed": {
      const raw = requireMinor(pick(record, spec.column), index, spec.column);
      return spec.outflow === "negative" ? raw : -raw;
    }
    case "debit-credit": {
      // Signs are presentation only — debit is out, credit is in.
      const out = Math.abs(minorOrZero(pick(record, spec.debit)));
      const inn = Math.abs(minorOrZero(pick(record, spec.credit)));
      return inn - out;
    }
    case "categorized": {
      const magnitude = Math.abs(requireMinor(pick(record, spec.column), index, spec.column));
      const isIncome = spec.incomePattern.test(pick(record, spec.categoryColumn));
      return isIncome ? magnitude : -magnitude;
    }
  }
}

function normalize(record: Record<string, string>, profile: ProfileSpec, index: number): NormalizedRow {
  const date = toIsoDate(pick(record, profile.dateColumn), index);
  const description =
    profile.descriptionColumns
      .map((c) => pick(record, c))
      .filter(Boolean)
      .join(" — ") || "(no description)";

  const row: NormalizedRow = { index, date, description, amountMinor: amountOf(record, profile, index) };

  if (profile.categoryColumn) {
    const cat = pick(record, profile.categoryColumn);
    const sub = profile.subCategoryColumn ? pick(record, profile.subCategoryColumn) : "";
    const hint = [cat, sub].filter(Boolean).join(" / ");
    if (hint) row.rawCategory = hint;
  }
  if (profile.propertyColumn) {
    const prop = pick(record, profile.propertyColumn);
    if (prop) row.rawProperty = prop;
  }
  return row;
}

/**
 * Parse raw CSV text under a named profile into normalized rows. Uses an
 * RFC-4180 parser (handles quoted fields, embedded newlines, doubled-quote
 * escapes) — never a hand-rolled split. Throws on an unknown profile or any
 * malformed date/amount, with the offending row number.
 */
export function parseCsv(csv: string, profileName: string): NormalizedRow[] {
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`Unknown profile "${profileName}". Available: ${listProfiles().join(", ")}.`);
  }
  const records = parse(csv, {
    columns: (header: string[]) => header.map((h) => h.trim()),
    skip_empty_lines: true,
    relax_column_count: true, // tolerate ragged trailing columns
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  return records.map((rec, i) => normalize(rec, profile, i));
}
