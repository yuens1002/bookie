import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Wrap structured data as a successful MCP tool result (JSON text). */
export function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Wrap an error message as a failed MCP tool result. */
export function fail(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
