import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Parse a tool's JSON response.
 *
 * When a tool fails, the server returns its error as plain **text**, not JSON.
 * Parsing that blindly throws `SyntaxError: Unexpected token 'I'` — which throws
 * away the only useful information and makes an intermittent failure impossible
 * to diagnose after the fact. A Prisma error surfaced exactly that way twice in
 * `report.test.ts`, and three clean re-runs could not reproduce it, so the cause
 * was never captured.
 *
 * Including the text costs nothing on the happy path and turns the next
 * occurrence into something actionable.
 */
export function parseToolResult(res: CallToolResult): any {
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error(
      `tool returned non-JSON text (likely a server-side error):\n${block.text.slice(0, 800)}`,
    );
  }
}
