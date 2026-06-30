/**
 * Bearer-token auth for the HTTP transport.
 *
 * When BOOKIE_API_KEY is unset this path returns { ok: false } — it does not
 * open the endpoint. The HTTP transport startup guard (startHttp) ensures at
 * least BOOKIE_API_KEY or JWT_SECRET is set before the server accepts
 * connections, so callers with a valid OAuth JWT still pass via the JWT check
 * in the MCP handler.
 */
export type AuthResult = { ok: true } | { ok: false; error: string };

export function requireAuth(authorizationHeader?: string): AuthResult {
  const expected = process.env.BOOKIE_API_KEY;
  if (!expected) return { ok: false, error: "no_static_key" };

  const provided = authorizationHeader?.replace(/^Bearer\s+/i, "").trim();
  if (provided && provided === expected) return { ok: true };
  return { ok: false, error: "unauthorized" };
}
