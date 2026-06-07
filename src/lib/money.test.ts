import { describe, it, expect } from "vitest";
import { toMinor, toMajor, formatMoney } from "./money.js";

describe("toMinor", () => {
  it("converts dollars to integer cents", () => {
    expect(toMinor(42.5)).toBe(4250);
    expect(toMinor(0)).toBe(0);
    expect(toMinor(1)).toBe(100);
    expect(toMinor(19.99)).toBe(1999);
  });

  it("rounds float artifacts to the nearest cent", () => {
    expect(toMinor(0.1 + 0.2)).toBe(30); // 0.30000000000000004
    expect(toMinor(19.99)).toBe(1999); // 1998.9999999999998 -> 1999
  });

  it("parses currency-formatted strings", () => {
    expect(toMinor("$1,234.56")).toBe(123456);
    expect(toMinor("  12.00 ")).toBe(1200);
    expect(toMinor("-42.50")).toBe(-4250);
  });

  it("throws on non-numeric input", () => {
    expect(() => toMinor("abc")).toThrow();
    expect(() => toMinor("")).toThrow();
  });
});

describe("toMajor", () => {
  it("converts cents back to dollars", () => {
    expect(toMajor(4250)).toBe(42.5);
    expect(toMajor(0)).toBe(0);
  });

  it("round-trips with toMinor", () => {
    for (const v of [0, 1, 42.5, 19.99, 1234.56, 999999.99]) {
      expect(toMajor(toMinor(v))).toBeCloseTo(v, 2);
    }
  });
});

describe("formatMoney", () => {
  it("renders USD with two decimals", () => {
    expect(formatMoney(4250)).toBe("$42.50");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(123456)).toBe("$1,234.56");
  });

  it("renders negatives", () => {
    expect(formatMoney(-4250)).toBe("-$42.50");
  });
});
