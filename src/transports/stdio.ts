import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "../server.js";
import { bootstrapLedger } from "./bootstrap.js";

export async function startStdio(): Promise<void> {
  const seeded = await bootstrapLedger();

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the MCP channel — all logs go to stderr.
  console.error(
    `bookie MCP server ready on stdio${seeded ? ` (seeded ${seeded} accounts)` : ""}`,
  );
}
