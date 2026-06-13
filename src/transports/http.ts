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

// --- in-memory fixed-window rate limiter ------------------------------------

const rateLimitRpm = Number(process.env.RATE_LIMIT_RPM ?? 60);
const windowMs = 60_000;
const rateLimitState = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const state = rateLimitState.get(ip);
  if (!state || now - state.windowStart >= windowMs) {
    rateLimitState.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (state.count >= rateLimitRpm) return false;
  state.count++;
  return true;
}

// --- HTTP transport ----------------------------------------------------------

export async function startHttp(): Promise<void> {
  const seeded = await bootstrapLedger();

  const app = new Hono<NodeBindings>();

  app.get("/health", (c) => c.json({ ok: true, service: "bookie", transport: "http" }));

  // Streamable HTTP MCP endpoint. Stateless: one server+transport per request.
  app.post("/mcp", async (c) => {
    const auth = requireAuth(c.req.header("authorization"));
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    // Rate limit by real client IP (X-Forwarded-For from Railway proxy, or socket address).
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.env.incoming.socket.remoteAddress ??
      "unknown";
    if (!checkRateLimit(ip)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }

    const body = (await c.req.json().catch(() => undefined)) as
      | { method?: string; params?: { name?: string } }
      | undefined;

    // Audit log: tool name is in params.name for tools/call, else fall back to method.
    const toolName = body?.params?.name ?? body?.method ?? "unknown";
    console.error(
      JSON.stringify({ ts: new Date().toISOString(), ip, method: body?.method ?? "unknown", toolName }),
    );

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
