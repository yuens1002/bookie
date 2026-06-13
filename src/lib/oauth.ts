import crypto from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { prisma } from "../db/client.js";

// --- in-memory auth code store (5-min TTL) -----------------------------------

type AuthCodeEntry = { clientId: string; codeChallenge: string; expiresAt: number };
const authCodes = new Map<string, AuthCodeEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(code);
  }
}, 60_000).unref();

export function issueAuthCode(clientId: string, codeChallenge: string): string {
  const code = crypto.randomBytes(32).toString("hex");
  authCodes.set(code, { clientId, codeChallenge, expiresAt: Date.now() + 5 * 60_000 });
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

export async function issueRefreshToken(clientId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.oAuthToken.create({
    data: { tokenHash: hashToken(token), clientId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  });
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

  const newToken = crypto.randomBytes(32).toString("hex");
  await prisma.oAuthToken.create({
    data: {
      tokenHash: hashToken(newToken),
      clientId: record.clientId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });

  return { clientId: record.clientId, newRefreshToken: newToken };
}

// --- timing-safe string comparison -------------------------------------------

export function timingSafeEqual(a: string, b: string): boolean {
  const aDigest = crypto.createHash("sha256").update(a).digest();
  const bDigest = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(aDigest, bDigest);
}
