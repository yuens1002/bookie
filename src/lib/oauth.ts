import crypto from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { prisma } from "../db/client.js";
import { timingSafeEqual } from "./crypto.js";

// --- in-memory auth code store (5-min TTL) -----------------------------------

type AuthCodeEntry = { clientId: string; codeChallenge: string; expiresAt: number };
const authCodes = new Map<string, AuthCodeEntry>();

export function issueAuthCode(clientId: string, codeChallenge: string): string {
  // Sweep expired entries here rather than on a timer. Codes are only ever added
  // in this function, so sweeping at insert bounds the map just as well — and a
  // periodic timer keeps the database compute from ever scaling to zero
  // (see docs/plans/oauth-idle-compute-plan.md).
  const now = Date.now();
  for (const [existing, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(existing);
  }

  const code = crypto.randomBytes(32).toString("hex");
  authCodes.set(code, { clientId, codeChallenge, expiresAt: now + 5 * 60_000 });
  return code;
}

export function consumeAuthCode(code: string): AuthCodeEntry | null {
  const entry = authCodes.get(code);
  if (!entry || entry.expiresAt < Date.now()) return null;
  authCodes.delete(code);
  return entry;
}

// --- PKCE --------------------------------------------------------------------

export function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return timingSafeEqual(hash, codeChallenge);
}

// --- JWT access tokens -------------------------------------------------------

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set");
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(clientId: string): Promise<string> {
  return new SignJWT({ sub: clientId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(getJwtSecret());
}

export async function verifyAccessToken(token: string): Promise<JWTPayload | null> {
  if (!process.env.JWT_SECRET) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), { algorithms: ["HS256"] });
    return payload;
  } catch {
    return null;
  }
}

// --- refresh tokens ----------------------------------------------------------

const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Drop refresh tokens that are already past their expiry.
 *
 * Runs on issuance instead of on a timer: issuance is the only event that adds
 * rows, and a periodic query would keep the database compute permanently awake
 * (see docs/plans/oauth-idle-compute-plan.md). Errors are swallowed — expired
 * rows are already rejected by `rotateRefreshToken`, so failing to delete them
 * is harmless, and housekeeping must never be able to fail an auth exchange.
 */
async function purgeExpiredTokens(): Promise<void> {
  try {
    await prisma.oAuthToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch (err) {
    console.error("oauth_tokens cleanup failed:", err);
  }
}

export async function issueRefreshToken(clientId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.oAuthToken.create({
    data: { tokenHash: hashToken(token), clientId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  });
  await purgeExpiredTokens();
  return token;
}

export async function rotateRefreshToken(
  token: string,
): Promise<{ clientId: string; newRefreshToken: string } | null> {
  const tokenHash = hashToken(token);
  const record = await prisma.oAuthToken.findUnique({ where: { tokenHash } });

  if (!record || record.expiresAt < new Date()) return null;

  if (record.consumed) {
    // Replay detected — revoke all tokens for this client
    await prisma.oAuthToken.deleteMany({ where: { clientId: record.clientId } });
    return null;
  }

  await prisma.oAuthToken.update({ where: { tokenHash }, data: { consumed: true } });

  const newRefreshToken = await issueRefreshToken(record.clientId);

  return { clientId: record.clientId, newRefreshToken };
}
