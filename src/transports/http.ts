import type { IncomingMessage, ServerResponse } from "node:http";
import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Hono, type Context } from "hono";
import { buildServer } from "../server.js";
import { bootstrapLedger } from "./bootstrap.js";
import { requireAuth } from "../lib/auth.js";
import {
  issueAuthCode,
  consumeAuthCode,
  verifyPKCE,
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
} from "../lib/oauth.js";

type NodeBindings = {
  Bindings: { incoming: IncomingMessage; outgoing: ServerResponse };
};

// --- in-memory fixed-window rate limiter ------------------------------------

const _rawRpm = Number(process.env.RATE_LIMIT_RPM);
const rateLimitRpm = Number.isInteger(_rawRpm) && _rawRpm > 0 ? _rawRpm : 60;
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

  // --- OAuth 2.0 (Claude.ai connector) ----------------------------------------

  const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const oauthClientId = process.env.OAUTH_CLIENT_ID ?? "claude-ai-connector";
  const allowedRedirectUris = (process.env.OAUTH_REDIRECT_URIS ?? "https://claude.ai/api/mcp/auth_callback")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/authorize`,
      token_endpoint: `${publicUrl}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: publicUrl,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ["header"],
    }),
  );

  app.get("/authorize", (c) => {
    const { client_id, code_challenge, code_challenge_method, redirect_uri, response_type, state } =
      c.req.query();

    if (response_type !== "code") return c.json({ error: "unsupported_response_type" }, 400);
    if (client_id !== oauthClientId) return c.json({ error: "unauthorized_client" }, 400);
    if (code_challenge_method !== "S256" || !code_challenge)
      return c.json({ error: "invalid_request", error_description: "S256 PKCE required" }, 400);

    if (!redirect_uri || !allowedRedirectUris.includes(redirect_uri))
      return c.json({ error: "invalid_request", error_description: "redirect_uri not allowed" }, 400);

    const code = issueAuthCode(client_id, code_challenge);
    const location = new URL(redirect_uri);
    location.searchParams.set("code", code);
    if (state) location.searchParams.set("state", state);
    return c.redirect(location.toString());
  });

  app.post("/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const body = contentType.includes("application/x-www-form-urlencoded")
      ? await c.req.parseBody().catch(() => ({})) as Record<string, string>
      : await c.req.json().catch(() => ({})) as Record<string, string>;
    const grantType = body.grant_type;

    // Single-owner gate: if OAUTH_CLIENT_SECRET is set, validate the client_secret Claude.ai
    // sends here (from the "OAuth Client Secret" field in the connector settings).
    const requiredSecret = process.env.OAUTH_CLIENT_SECRET;
    if (requiredSecret && body.client_secret !== requiredSecret)
      return c.json({ error: "invalid_client" }, 401);

    if (grantType === "authorization_code") {
      const { code, code_verifier, client_id } = body;
      if (client_id !== oauthClientId) return c.json({ error: "unauthorized_client" }, 400);

      const entry = consumeAuthCode(code ?? "");
      if (!entry) return c.json({ error: "invalid_grant" }, 400);
      if (!verifyPKCE(code_verifier ?? "", entry.codeChallenge))
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);

      const [accessToken, refreshToken] = await Promise.all([
        signAccessToken(client_id),
        issueRefreshToken(client_id),
      ]);
      return c.json(
        { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken },
        200,
        { "Cache-Control": "no-store", "Pragma": "no-cache" },
      );
    }

    if (grantType === "refresh_token") {
      const result = await rotateRefreshToken(body.refresh_token ?? "");
      if (!result) return c.json({ error: "invalid_grant" }, 400);

      const [accessToken, newRefreshToken] = await Promise.all([
        signAccessToken(result.clientId),
        Promise.resolve(result.newRefreshToken),
      ]);
      return c.json(
        { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: newRefreshToken },
        200,
        { "Cache-Control": "no-store", "Pragma": "no-cache" },
      );
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  // --- MCP endpoint ------------------------------------------------------------

  // Streamable HTTP MCP endpoint. Stateless: one server+transport per request.
  // Registered at both /mcp and / — Claude.ai may POST to the connector base URL
  // (root) or to the explicit /mcp path depending on how the connector URL was entered.
  const mcpHandler = async (c: Context<NodeBindings>) => {
    // Rate limit before auth — protects against unauthenticated floods/brute-force.
    // Use last entry in X-Forwarded-For (Railway appends real client IP; first entry is
    // client-supplied and spoofable).
    const xForwardedFor = c.req.header("x-forwarded-for");
    const ip =
      (xForwardedFor ? xForwardedFor.split(",").at(-1)?.trim() : undefined) ??
      c.env.incoming.socket.remoteAddress ??
      "unknown";
    if (!checkRateLimit(ip)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }

    const authHeader = c.req.header("authorization") ?? "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

    // Accept either: static BOOKIE_API_KEY (Claude Desktop) or OAuth JWT (Claude.ai)
    const staticAuth = requireAuth(authHeader);
    const jwtPayload = staticAuth.ok ? null : (bearerToken ? await verifyAccessToken(bearerToken) : null);

    if (!staticAuth.ok && !jwtPayload) {
      return c.json(
        { error: "unauthorized" },
        401,
        { "WWW-Authenticate": `Bearer realm="${publicUrl}", resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"` },
      );
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
  };

  app.post("/mcp", mcpHandler);
  app.post("/", mcpHandler);

  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  console.error(
    `bookie MCP server ready on http://localhost:${port}/mcp (also POST /)${seeded ? ` (seeded ${seeded} accounts)` : ""}`,
  );
}
