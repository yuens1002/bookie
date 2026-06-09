import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerSegmentTools } from "./tools/segments.js";
import { registerPropertyTools } from "./tools/properties.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerImportTools } from "./tools/import.js";
import { registerRuleTools } from "./tools/rules.js";

/** Build a fully-configured Bookie MCP server (no transport attached). */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "bookie", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        "Bookie keeps a double-entry ledger for personal and business finances. " +
        "Categories are expense/income accounts. Record spending with add_transaction " +
        "(from your bank/card account TO an expense account). Use account_balances and " +
        "query_transactions to inspect the ledger.",
    },
  );

  registerSegmentTools(server);
  registerAccountTools(server);
  registerPropertyTools(server);
  registerTransactionTools(server);
  registerImportTools(server);
  registerRuleTools(server);

  return server;
}
