import { describe, it, expect } from "vitest";
import { parseCsv } from "./parse.js";

describe("parseCsv — signed-amount profile", () => {
  const CSV_CHECKING = `Date,Description,Amount
01/02/2026,AIRBNB 4977,520.89
01/08/2026,SEATTLEUTILTIES,-154.04`;

  it("deposit (positive) → amountMinor positive (money in)", () => {
    const [row] = parseCsv(CSV_CHECKING, "signed-amount");
    expect(row!.amountMinor).toBe(52089);
  });

  it("payment (negative) → amountMinor negative (money out)", () => {
    const [, row] = parseCsv(CSV_CHECKING, "signed-amount");
    expect(row!.amountMinor).toBe(-15404);
  });

  // CC statements: positive = charge (liability ↑), negative = credit/refund (liability ↓).
  // The POSTING SIGN FLIP for liability accounts (signed-amount profile only) lives in
  // src/tools/import.ts (commit phase). For signed-amount the parser preserves the raw
  // statement sign; debit-credit and categorized profiles normalize independently.
  const CSV_CC = `Date,Description,Amount
01/08/2026,AMAZON MKTPL*F21VQ2873,110.54
01/05/2026,AMAZON MKTPLACE PMTS,-5.61
01/02/2026,SP+AFF* ROK COFFEE,-39.00`;

  it("CC charge (positive) → amountMinor positive", () => {
    const [row] = parseCsv(CSV_CC, "signed-amount");
    expect(row!.amountMinor).toBe(11054);
  });

  it("CC credit/refund (negative) → amountMinor negative", () => {
    const [, row] = parseCsv(CSV_CC, "signed-amount");
    expect(row!.amountMinor).toBe(-561);
  });

  it("CC credit with larger value (negative) → amountMinor negative", () => {
    const [, , row] = parseCsv(CSV_CC, "signed-amount");
    expect(row!.amountMinor).toBe(-3900);
  });
});

describe("parseCsv — posting direction invariant", () => {
  // Verifies the invariant that import.ts relies on to decide posting signs:
  // asset account (checking): amountMinor > 0 → credit received, < 0 → payment made
  // liability account (CC):   amountMinor > 0 → charge (caller must flip to credit liability),
  //                           amountMinor < 0 → refund/credit (caller must flip to debit liability)
  it("raw sign matches the bank statement sign (no hidden inversion in parser)", () => {
    const csv = `Date,Description,Amount\n2026-01-01,FOO,42.50\n2026-01-01,BAR,-10.00`;
    const [pos, neg] = parseCsv(csv, "signed-amount");
    expect(pos!.amountMinor).toBeGreaterThan(0);
    expect(neg!.amountMinor).toBeLessThan(0);
  });
});
