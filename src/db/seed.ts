import { pathToFileURL } from "node:url";
import { prisma } from "./client.js";
import { newId } from "../lib/id.js";

type TaxSchedule = "C" | "E";

type SeedSegment = { name: string; taxSchedule: TaxSchedule | null };

type SeedAccount = {
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  segment?: string; // segment name; omit for segment-neutral banking accounts
  taxLine?: string;
};

/**
 * Generic default chart for someone running personal finances, a sole
 * proprietorship (Schedule C), and rental real estate (Schedule E) out of one
 * ledger. A sensible starting point for any user — rename/extend via
 * manage_segments / manage_accounts. (Personal real-world setups live outside
 * this committed seed.)
 */
const SEGMENTS: SeedSegment[] = [
  { name: "Personal", taxSchedule: null },
  { name: "Sole Proprietorship", taxSchedule: "C" },
  { name: "Rental Real Estate", taxSchedule: "E" },
];

const DEFAULT_CHART: SeedAccount[] = [
  // --- Segment-neutral banking (one card can span segments) ---
  { name: "Checking", type: "asset" },
  { name: "Savings", type: "asset" },
  { name: "Credit Card", type: "liability" },
  { name: "Owner's Equity", type: "equity" },

  // --- Personal ---
  { name: "Other Income", type: "income", segment: "Personal" },
  { name: "Groceries", type: "expense", segment: "Personal" },
  { name: "Dining", type: "expense", segment: "Personal" },
  { name: "Housing", type: "expense", segment: "Personal" },
  { name: "Transportation", type: "expense", segment: "Personal" },
  { name: "Health", type: "expense", segment: "Personal" },
  { name: "Uncategorized", type: "expense", segment: "Personal" },

  // --- Sole Proprietorship (Schedule C) ---
  { name: "Business Income", type: "income", segment: "Sole Proprietorship", taxLine: "Line 1 — Gross receipts or sales" },
  { name: "Advertising", type: "expense", segment: "Sole Proprietorship", taxLine: "Line 8 — Advertising" },
  { name: "Car & Truck", type: "expense", segment: "Sole Proprietorship", taxLine: "Line 9 — Car and truck expenses" },
  { name: "Contract Labor", type: "expense", segment: "Sole Proprietorship", taxLine: "Line 11 — Contract labor" },
  { name: "Office Expense", type: "expense", segment: "Sole Proprietorship", taxLine: "Line 18 — Office expense" },
  { name: "Supplies", type: "expense", segment: "Sole Proprietorship", taxLine: "Line 22 — Supplies" },
  { name: "Travel", type: "expense", segment: "Sole Proprietorship", taxLine: "Line 24a — Travel" },
  { name: "Meals", type: "expense", segment: "Sole Proprietorship", taxLine: "Line 24b — Deductible meals" },
  { name: "Software & Subscriptions", type: "expense", segment: "Sole Proprietorship", taxLine: "Line 27a — Other expenses" },

  // --- Rental Real Estate (Schedule E) ---
  { name: "Rental Income", type: "income", segment: "Rental Real Estate", taxLine: "Line 3 — Rents received" },
  { name: "Rental Advertising", type: "expense", segment: "Rental Real Estate", taxLine: "Line 5 — Advertising" },
  { name: "Rental Auto & Travel", type: "expense", segment: "Rental Real Estate", taxLine: "Line 6 — Auto and travel" },
  { name: "Rental Cleaning & Maintenance", type: "expense", segment: "Rental Real Estate", taxLine: "Line 7 — Cleaning and maintenance" },
  { name: "Rental Insurance", type: "expense", segment: "Rental Real Estate", taxLine: "Line 9 — Insurance" },
  { name: "Rental Legal & Professional", type: "expense", segment: "Rental Real Estate", taxLine: "Line 10 — Legal and other professional fees" },
  { name: "Rental Management Fees", type: "expense", segment: "Rental Real Estate", taxLine: "Line 11 — Management fees" },
  { name: "Rental Mortgage Interest", type: "expense", segment: "Rental Real Estate", taxLine: "Line 12 — Mortgage interest paid to banks" },
  { name: "Rental Repairs", type: "expense", segment: "Rental Real Estate", taxLine: "Line 14 — Repairs" },
  { name: "Rental Supplies", type: "expense", segment: "Rental Real Estate", taxLine: "Line 15 — Supplies" },
  { name: "Rental Property Tax", type: "expense", segment: "Rental Real Estate", taxLine: "Line 16 — Taxes" },
  { name: "Rental Utilities", type: "expense", segment: "Rental Real Estate", taxLine: "Line 17 — Utilities" },
  { name: "Rental Depreciation", type: "expense", segment: "Rental Real Estate", taxLine: "Line 18 — Depreciation expense or depletion" },
  { name: "Rental Other", type: "expense", segment: "Rental Real Estate", taxLine: "Line 19 — Other" },
];

/** Seed the default segments + chart only when the ledger has no accounts yet. */
export async function ensureDefaultChart(): Promise<number> {
  // Skip if EITHER table is populated — seeding again would collide with
  // existing (unique) segment names.
  const [accounts, segments] = await Promise.all([
    prisma.account.count(),
    prisma.segment.count(),
  ]);
  if (accounts > 0 || segments > 0) return 0;

  const segmentIds = new Map<string, string>();
  for (const s of SEGMENTS) {
    const id = newId("seg");
    segmentIds.set(s.name, id);
    await prisma.segment.create({
      data: { id, name: s.name, taxSchedule: s.taxSchedule },
    });
  }

  await prisma.account.createMany({
    data: DEFAULT_CHART.map((a) => {
      let segmentId: string | null = null;
      if (a.segment) {
        const id = segmentIds.get(a.segment);
        if (!id) throw new Error(`Seed error: account "${a.name}" references unknown segment "${a.segment}".`);
        segmentId = id;
      }
      return { id: newId("acc"), name: a.name, type: a.type, segmentId, taxLine: a.taxLine ?? null };
    }),
  });
  return DEFAULT_CHART.length;
}

// `npm run db:seed` / `prisma db seed`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = await ensureDefaultChart();
  console.log(
    n > 0
      ? `Seeded ${SEGMENTS.length} segments + ${n} default accounts.`
      : "Ledger already has accounts — nothing to seed.",
  );
  await prisma.$disconnect();
  process.exit(0);
}
