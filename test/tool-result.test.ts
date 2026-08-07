import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseToolResult } from "./tool-result.js";

const textResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

describe("parseToolResult", () => {
  it("parses a JSON tool response", () => {
    expect(parseToolResult(textResult('{"ok":true,"n":2}'))).toEqual({ ok: true, n: 2 });
  });

  // The point of the helper. A failing tool returns its error as plain text, and
  // parsing that blindly produced `SyntaxError: Unexpected token 'I'` — which
  // discarded the actual cause. This is the shape that flaked twice in
  // report.test.ts with nothing left to diagnose.
  it("surfaces the server's error text instead of a JSON syntax error", () => {
    const prismaError = "\nInvalid `prisma.journalEntry.findMany()` invocation:\nTimed out fetching a new connection";
    expect(() => parseToolResult(textResult(prismaError))).toThrowError(/Invalid `prisma\.journalEntry\.findMany\(\)` invocation/);
    expect(() => parseToolResult(textResult(prismaError))).toThrowError(/Timed out fetching a new connection/);
  });

  it("does not report a JSON syntax error for non-JSON text", () => {
    expect(() => parseToolResult(textResult("Invalid ..."))).not.toThrowError(/Unexpected token/);
  });

  it("truncates very long error text", () => {
    const long = `Invalid ${"x".repeat(5000)}`;
    try {
      parseToolResult(textResult(long));
      throw new Error("expected it to throw");
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(1000);
    }
  });

  it("rejects a non-text content block", () => {
    const res = { content: [{ type: "image", data: "", mimeType: "image/png" }] } as unknown as CallToolResult;
    expect(() => parseToolResult(res)).toThrowError(/expected text content/);
  });

  it("rejects an empty content array", () => {
    expect(() => parseToolResult({ content: [] } as unknown as CallToolResult)).toThrowError(/expected text content/);
  });
});
