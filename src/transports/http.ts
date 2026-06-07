import type { IncomingMessage, ServerResponse } from "node:http";
import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Hono } from "hono";
import { buildServer } from "../server.js";
import { bootstrapLedger } from "./bootstrap.js";
import { requireAuth } from "../lib/auth.js";

type NodeBindings = {
  Bindings: { incoming: IncomingMessage; outgoing: ServerResponse };
};

export async function startHttp(): Promise<void> {
  const seeded = await bootstrapLedger();

  const app = new Hono<NodeBindings>();

  app.get("/health", (c) => c.json({ ok: true, service: "bookie", transport: "http" }));

  // Streamable HTTP MCP endpoint. Stateless: one server+transport per request.
  app.post("/mcp", async (c) => {
    const auth = requireAuth(c.req.header("authorization"));
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const body = await c.req.json().catch(() => undefined);
    const { incoming, outgoing } = c.env;

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    outgoing.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(incoming, outgoing, body);
    return RESPONSE_ALREADY_SENT;
  });

  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  console.error(
    `bookie MCP server ready on http://localhost:${port}/mcp${seeded ? ` (seeded ${seeded} accounts)` : ""}`,
  );
}
