import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import {
  issueAuthCode,
  consumeAuthCode,
  verifyPKCE,
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
} from "../src/lib/oauth.js";
import crypto from "node:crypto";

// Unit tests for OAuth crypto logic — no HTTP layer, no MCP server.
// Runs against the Neon dev branch (refresh tokens go to the DB).

const TEST_CLIENT = "test-client";

// Purge any refresh tokens created during this run.
const createdTokenHashes: string[] = [];

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

beforeAll(() => {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
});

afterAll(async () => {
  if (createdTokenHashes.length) {
    await prisma.oAuthToken.deleteMany({ where: { tokenHash: { in: createdTokenHashes } } });
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Auth codes
// ---------------------------------------------------------------------------

describe("auth codes", () => {
  it("issues and consumes a code exactly once", () => {
    const challenge = crypto.randomBytes(32).toString("base64url");
    const code = issueAuthCode(TEST_CLIENT, challenge);
    expect(code).toHaveLength(64);

    const entry = consumeAuthCode(code);
    expect(entry).not.toBeNull();
    expect(entry!.clientId).toBe(TEST_CLIENT);
    expect(entry!.codeChallenge).toBe(challenge);

    // second consume returns null — code was deleted
    expect(consumeAuthCode(code)).toBeNull();
  });

  it("returns null for an unknown code", () => {
    expect(consumeAuthCode("notacode")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PKCE S256
// ---------------------------------------------------------------------------

describe("verifyPKCE", () => {
  it("accepts correct verifier", () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPKCE(verifier, challenge)).toBe(true);
  });

  it("rejects wrong verifier", () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const wrongVerifier = crypto.randomBytes(32).toString("base64url");
    expect(verifyPKCE(wrongVerifier, challenge)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JWT access tokens
// ---------------------------------------------------------------------------

describe("access tokens", () => {
  it("signs and verifies a token for the correct client", async () => {
    const token = await signAccessToken(TEST_CLIENT);
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // header.payload.sig

    const payload = await verifyAccessToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(TEST_CLIENT);
  });

  it("rejects a tampered token", async () => {
    const token = await signAccessToken(TEST_CLIENT);
    const tampered = token.slice(0, -4) + "xxxx";
    expect(await verifyAccessToken(tampered)).toBeNull();
  });

  it("returns null when JWT_SECRET is unset", async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const token = "eyJhbGciOiJIUzI1NiJ9.e30.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(await verifyAccessToken(token)).toBeNull();
    process.env.JWT_SECRET = saved;
  });
});

// ---------------------------------------------------------------------------
// Refresh tokens — rotation and replay detection
// ---------------------------------------------------------------------------

describe("refresh tokens", () => {
  it("issues, rotates, and invalidates the old token", async () => {
    const original = await issueRefreshToken(TEST_CLIENT);
    createdTokenHashes.push(sha256hex(original));

    const result = await rotateRefreshToken(original);
    expect(result).not.toBeNull();
    expect(result!.clientId).toBe(TEST_CLIENT);
    createdTokenHashes.push(sha256hex(result!.newRefreshToken));

    // old token is now consumed — rotate again returns null
    expect(await rotateRefreshToken(original)).toBeNull();
  });

  it("revokes all client tokens on replay of a consumed token", async () => {
    const first = await issueRefreshToken(TEST_CLIENT);
    createdTokenHashes.push(sha256hex(first));

    const rotated = await rotateRefreshToken(first);
    expect(rotated).not.toBeNull();
    const second = rotated!.newRefreshToken;
    createdTokenHashes.push(sha256hex(second));

    // replay the consumed first token — should revoke everything including second
    expect(await rotateRefreshToken(first)).toBeNull();
    // second token is now gone too
    expect(await rotateRefreshToken(second)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await rotateRefreshToken("notarealtoken")).toBeNull();
  });
});
