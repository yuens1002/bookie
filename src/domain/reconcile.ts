/**
 * Statement-to-ledger reconciliation engine. Pure functions only — the tool
 * handler fetches data from Prisma and passes it in, so this stays deterministic
 * and unit-testable without a database.
 *
 * Match criterion: a statement line matches a ledger posting when
 *   - amounts are equal (signed minor units), AND
 *   - the dates are within `windowDays` of each other.
 *
 * Already-cleared postings are included in matching (for idempotency) but
 * are flagged with `alreadyCleared: true` so the commit handler can skip them.
 * Only uncleared, unmatched postings land in `inLedgerNotOnStatement`.
 */

export interface StatementLine {
  index: number; // 0-based position in the parsed CSV
  date: string; // ISO YYYY-MM-DD
  description: string;
  amount: number; // signed minor units (+ = money in, − = money out)
}

export interface LedgerPosting {
  id: string;
  amount: number; // signed minor units
  entryId: string;
  date: string; // ISO, from the parent JournalEntry
  description: string; // from the parent JournalEntry
  cleared: boolean;
}

export interface ReconcileMatch {
  statementIndex: number;
  statementDate: string;
  statementDescription: string;
  statementAmount: number;
  postingId: string;
  entryId: string;
  alreadyCleared: boolean; // true when the posting was cleared before this run
}

export interface ReconcileResult {
  matched: ReconcileMatch[];
  /** Statement lines that found no matching ledger posting. */
  onStatementNotInLedger: StatementLine[];
  /** Uncleared ledger postings that matched no statement line. */
  inLedgerNotOnStatement: LedgerPosting[];
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(a) - Date.parse(b));
  return Math.round(ms / 86_400_000);
}

/**
 * Match each statement line to the nearest (first by array order) unmatched
 * ledger posting with the same amount within `windowDays`. Each posting is
 * consumed at most once.
 *
 * Pre-indexes postings by amount so the inner loop only scans same-amount
 * candidates — O(n + m) rather than O(n*m).
 */
export function matchStatementToLedger(params: {
  statementLines: StatementLine[];
  ledgerPostings: LedgerPosting[];
  windowDays: number;
}): ReconcileResult {
  const { statementLines, ledgerPostings, windowDays } = params;

  const postingsByAmount = new Map<number, LedgerPosting[]>();
  for (const p of ledgerPostings) {
    const bucket = postingsByAmount.get(p.amount);
    if (bucket) {
      bucket.push(p);
    } else {
      postingsByAmount.set(p.amount, [p]);
    }
  }

  const usedPostingIds = new Set<string>();
  const matched: ReconcileMatch[] = [];
  const onStatementNotInLedger: StatementLine[] = [];

  for (const line of statementLines) {
    const candidates = postingsByAmount.get(line.amount) ?? [];
    const posting = candidates.find(
      (p) => !usedPostingIds.has(p.id) && daysBetween(p.date, line.date) <= windowDays,
    );

    if (posting) {
      usedPostingIds.add(posting.id);
      matched.push({
        statementIndex: line.index,
        statementDate: line.date,
        statementDescription: line.description,
        statementAmount: line.amount,
        postingId: posting.id,
        entryId: posting.entryId,
        alreadyCleared: posting.cleared,
      });
    } else {
      onStatementNotInLedger.push(line);
    }
  }

  // Uncleared postings that no statement line consumed.
  const inLedgerNotOnStatement = ledgerPostings.filter(
    (p) => !p.cleared && !usedPostingIds.has(p.id),
  );

  return { matched, onStatementNotInLedger, inLedgerNotOnStatement };
}
