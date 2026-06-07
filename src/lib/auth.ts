/**
 * Bearer-token auth for the HTTP transport. If `BOOKIE_API_KEY` is unset the
 * endpoint is open — acceptable for localhost only. Set it before exposing
 * the server publicly (e.g. on Railway).
 */
export type AuthResult = { ok: true } | { ok: false; error: string };

export function requireAuth(authorizationHeader?: string): AuthResult {
  const expected = process.env.BOOKIE_API_KEY;
  if (!expected) return { ok: true };

  const provided = authorizationHeader?.replace(/^Bearer\s+/i, "").trim();
  if (provided && provided === expected) return { ok: true };
  return { ok: false, error: "unauthorized" };
}
