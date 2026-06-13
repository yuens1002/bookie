/**
 * Fiscal-year tax report engines (Schedule C and Schedule E).
 * Pure functions only — the tool handler fetches data from Prisma and maps
 * to TaxPosting before calling these, so this file stays deterministic and
 * unit-testable without a database.
 *
 * Sign convention (carried through from the ledger):
 *   expense account postings: positive (debit)
 *   income account postings:  negative (credit)
 * Both functions negate income totals so all reported figures are positive.
 */

export interface TaxPosting {
  id: string;
  amount: number; // signed minor units
  accountId: string;
  accountType: string; // 'income' | 'expense' — only income/expense postings are passed here
  accountName: string;
  taxLine: string | null; // null → grouped into "Unclassified"
  entryId: string;
  entryDate: string;
  propertyId: string | null; // relevant for Schedule E only
  propertyName: string | null;
}

export interface TaxAccountSummary {
  accountId: string;
  accountName: string;
  totalMinor: number; // positive: expense=debit amount, income=sign-flipped credit
}

export interface TaxLineSummary {
  taxLine: string; // "Unclassified" when account.taxLine is null
  accounts: TaxAccountSummary[];
  totalMinor: number; // sum of account totals (positive)
}

export interface ScheduleCResult {
  year: number;
  incomeLines: TaxLineSummary[];
  expenseLines: TaxLineSummary[];
  totalIncomeMinor: number;
  totalExpensesMinor: number;
  netMinor: number; // totalIncomeMinor - totalExpensesMinor
}

export interface ScheduleEProperty {
  propertyId: string | null; // null = entries with no propertyId
  propertyName: string; // "Unassigned" when propertyId is null
  incomeLines: TaxLineSummary[];
  expenseLines: TaxLineSummary[];
  totalIncomeMinor: number;
  totalExpensesMinor: number;
  netMinor: number;
}

export interface ScheduleEResult {
  year: number;
  properties: ScheduleEProperty[];
  totalNetMinor: number;
}

const UNCLASSIFIED = "Unclassified";
const UNASSIGNED_PROPERTY_NAME = "Unassigned";

/**
 * Group postings by taxLine within one income or expense bucket.
 * Lines sorted alphabetically; "Unclassified" sorts last.
 */
function groupByTaxLine(postings: TaxPosting[], isIncome: boolean): TaxLineSummary[] {
  const lineMap = new Map<string, Map<string, { accountName: string; total: number }>>();

  for (const p of postings) {
    if (isIncome ? p.accountType !== "income" : p.accountType !== "expense") continue;

    const lineKey = p.taxLine ?? UNCLASSIFIED;
    if (!lineMap.has(lineKey)) {
      lineMap.set(lineKey, new Map());
    }
    const accountMap = lineMap.get(lineKey)!;
    // Income postings are credits (negative); negate so every displayed figure is positive.
    const displayAmount = isIncome ? -p.amount : p.amount;
    const existing = accountMap.get(p.accountId);
    if (existing) {
      existing.total += displayAmount;
    } else {
      accountMap.set(p.accountId, { accountName: p.accountName, total: displayAmount });
    }
  }

  return Array.from(lineMap.entries())
    .sort(([a], [b]) => {
      if (a === UNCLASSIFIED) return 1;
      if (b === UNCLASSIFIED) return -1;
      return a.localeCompare(b);
    })
    .map(([taxLine, accountMap]) => {
      const accounts: TaxAccountSummary[] = Array.from(accountMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([accountId, { accountName, total }]) => ({
          accountId,
          accountName,
          totalMinor: total,
        }));
      return {
        taxLine,
        accounts,
        totalMinor: accounts.reduce((s, a) => s + a.totalMinor, 0),
      };
    });
}

/** Schedule C: sole-proprietor fiscal-year P&L grouped by Schedule C tax line. */
export function computeScheduleC(postings: TaxPosting[], year: number): ScheduleCResult {
  const incomeLines = groupByTaxLine(postings, true);
  const expenseLines = groupByTaxLine(postings, false);
  const totalIncomeMinor = incomeLines.reduce((s, l) => s + l.totalMinor, 0);
  const totalExpensesMinor = expenseLines.reduce((s, l) => s + l.totalMinor, 0);
  return {
    year,
    incomeLines,
    expenseLines,
    totalIncomeMinor,
    totalExpensesMinor,
    netMinor: totalIncomeMinor - totalExpensesMinor,
  };
}

/**
 * Schedule E: rental real estate fiscal-year P&L grouped by property then by
 * Schedule E tax line. Postings whose entry has no propertyId go into an
 * "Unassigned" property bucket.
 */
export function computeScheduleE(postings: TaxPosting[], year: number): ScheduleEResult {
  const propMap = new Map<string | null, { propertyName: string; postings: TaxPosting[] }>();

  for (const p of postings) {
    if (!propMap.has(p.propertyId)) {
      propMap.set(p.propertyId, {
        propertyName: p.propertyName ?? UNASSIGNED_PROPERTY_NAME,
        postings: [],
      });
    }
    propMap.get(p.propertyId)!.postings.push(p);
  }

  const properties: ScheduleEProperty[] = Array.from(propMap.entries())
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    })
    .map(([propertyId, { propertyName, postings: propPostings }]) => {
      const incomeLines = groupByTaxLine(propPostings, true);
      const expenseLines = groupByTaxLine(propPostings, false);
      const totalIncomeMinor = incomeLines.reduce((s, l) => s + l.totalMinor, 0);
      const totalExpensesMinor = expenseLines.reduce((s, l) => s + l.totalMinor, 0);
      return {
        propertyId,
        propertyName,
        incomeLines,
        expenseLines,
        totalIncomeMinor,
        totalExpensesMinor,
        netMinor: totalIncomeMinor - totalExpensesMinor,
      };
    });

  return {
    year,
    properties,
    totalNetMinor: properties.reduce((s, p) => s + p.netMinor, 0),
  };
}
