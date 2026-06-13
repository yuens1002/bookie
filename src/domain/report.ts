/**
 * Monthly reconciliation report engine. Pure functions only — the tool handler
 * fetches data from Prisma and passes it in, so this stays deterministic and
 * unit-testable without a database.
 *
 * Sign convention (carried through from the ledger):
 *   expense account postings: positive (debit)
 *   income account postings:  negative (credit)
 * The report negates income totals so all displayed figures are positive.
 */

export interface ReportPosting {
  id: string;
  amount: number; // signed minor units
  accountId: string;
  accountType: string; // 'asset' | 'liability' | 'equity' | 'income' | 'expense'
  accountName: string;
  segmentId: string | null;
  segmentName: string | null;
  cleared: boolean;
  entryId: string;
  entryDate: string;
  entryDescription: string;
}

export interface ReportEntry {
  id: string;
  date: string;
  description: string;
  postingAccountTypes: string[];
}

export interface AccountSummary {
  accountId: string;
  accountName: string;
  totalMinor: number; // raw signed ledger total for this account
}

export interface SegmentSummary {
  segmentId: string | null;
  segmentName: string | null;
  incomeMinor: number; // positive: sum of income account credits (sign-flipped)
  expensesMinor: number; // positive: sum of expense account debits
  netMinor: number; // incomeMinor - expensesMinor
  accounts: AccountSummary[];
}

export interface UncategorizedEntry {
  entryId: string;
  date: string;
  description: string;
}

export interface UnclearedPosting {
  postingId: string;
  entryId: string;
  date: string;
  description: string;
  accountId: string;
  accountName: string;
  amountMinor: number;
}

export interface MonthlyReportResult {
  year: number;
  month: number;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  accountId: string | null;
  accountName: string | null;
  openingBalanceMinor: number | null; // null when no accountId supplied
  closingBalanceMinor: number | null;
  bySegment: SegmentSummary[];
  uncategorizedEntries: UncategorizedEntry[];
  unclearedPaymentPostings: UnclearedPosting[];
}

export interface MonthlyReportInput {
  year: number;
  month: number; // 1-12
  accountId: string | null;
  accountName: string | null;
  // Postings on accountId dated before the month start (for opening balance).
  // Pass empty array when no accountId is supplied.
  preMonthAccountPostings: { amount: number }[];
  // All postings whose parent entry falls within the month.
  monthPostings: ReportPosting[];
  // All entries within the month (for uncategorized check).
  monthEntries: ReportEntry[];
}

/** ISO YYYY-MM-DD for the last calendar day of the given month (1-based). */
export function lastDayOfMonth(year: number, month: number): string {
  // Day 0 of month+1 (0-based in Date.UTC) = last day of `month`.
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

export function computeMonthlyReport(input: MonthlyReportInput): MonthlyReportResult {
  const { year, month } = input;
  const mm = String(month).padStart(2, "0");
  const periodStart = `${year}-${mm}-01`;
  const periodEnd = lastDayOfMonth(year, month);

  // --- opening / closing balance ----------------------------------------------
  let openingBalanceMinor: number | null = null;
  let closingBalanceMinor: number | null = null;
  if (input.accountId !== null) {
    const opening = input.preMonthAccountPostings.reduce((s, p) => s + p.amount, 0);
    const inMonth = input.monthPostings
      .filter((p) => p.accountId === input.accountId)
      .reduce((s, p) => s + p.amount, 0);
    openingBalanceMinor = opening;
    closingBalanceMinor = opening + inMonth;
  }

  // --- categorized totals by segment -----------------------------------------
  // segKey → segment metadata + per-account totals
  const segmentMap = new Map<
    string | null,
    {
      segmentName: string | null;
      incomeMinor: number;
      expensesMinor: number;
      accountMap: Map<string, { accountName: string; totalMinor: number }>;
    }
  >();

  for (const p of input.monthPostings) {
    if (p.accountType !== "income" && p.accountType !== "expense") continue;

    const segKey = p.segmentId;
    if (!segmentMap.has(segKey)) {
      segmentMap.set(segKey, {
        segmentName: p.segmentName,
        incomeMinor: 0,
        expensesMinor: 0,
        accountMap: new Map(),
      });
    }
    const seg = segmentMap.get(segKey)!;

    const acct = seg.accountMap.get(p.accountId);
    if (acct) {
      acct.totalMinor += p.amount;
    } else {
      seg.accountMap.set(p.accountId, { accountName: p.accountName, totalMinor: p.amount });
    }

    if (p.accountType === "income") {
      // Income postings are credits (negative); negate so incomeMinor is positive.
      seg.incomeMinor += -p.amount;
    } else {
      // Expense postings are debits (positive).
      seg.expensesMinor += p.amount;
    }
  }

  const bySegment: SegmentSummary[] = [];
  for (const [segmentId, { segmentName, incomeMinor, expensesMinor, accountMap }] of segmentMap) {
    bySegment.push({
      segmentId,
      segmentName,
      incomeMinor,
      expensesMinor,
      netMinor: incomeMinor - expensesMinor,
      // Sort accounts by id for stable output regardless of DB/Map insertion order.
      accounts: Array.from(accountMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([accountId, { accountName, totalMinor }]) => ({
          accountId,
          accountName,
          totalMinor,
        })),
    });
  }
  // Sort segments by id (null last) for stable output.
  bySegment.sort((a, b) => {
    if (a.segmentId === null) return 1;
    if (b.segmentId === null) return -1;
    return a.segmentId.localeCompare(b.segmentId);
  });

  // --- uncategorized entries --------------------------------------------------
  const uncategorizedEntries: UncategorizedEntry[] = input.monthEntries
    .filter((e) => !e.postingAccountTypes.some((t) => t === "income" || t === "expense"))
    .map((e) => ({ entryId: e.id, date: e.date, description: e.description }));

  // --- uncleared payment postings --------------------------------------------
  const unclearedPaymentPostings: UnclearedPosting[] = input.monthPostings
    .filter((p) => (p.accountType === "asset" || p.accountType === "liability") && !p.cleared)
    .map((p) => ({
      postingId: p.id,
      entryId: p.entryId,
      date: p.entryDate,
      description: p.entryDescription,
      accountId: p.accountId,
      accountName: p.accountName,
      amountMinor: p.amount,
    }));

  return {
    year,
    month,
    periodStart,
    periodEnd,
    accountId: input.accountId,
    accountName: input.accountName,
    openingBalanceMinor,
    closingBalanceMinor,
    bySegment,
    uncategorizedEntries,
    unclearedPaymentPostings,
  };
}
