import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
let savedJwtSecret: string | undefined;

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

beforeAll(() => {
  savedJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
});

afterAll(async () => {
  if (savedJwtSecret !== undefined) {
    process.env.JWT_SECRET = savedJwtSecret;
  } else {
    delete process.env.JWT_SECRET;
  }
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

  // The 5-minute TTL used to be swept by the same 60s timer that kept the
  // database compute awake. Sweeping now happens on issue; expiry itself is
  // still enforced by consumeAuthCode, which is what this guards.
  it("rejects a code past its 5-minute TTL", () => {
    vi.useFakeTimers();
    try {
      const challenge = crypto.randomBytes(32).toString("base64url");
      const code = issueAuthCode(TEST_CLIENT, challenge);

      vi.advanceTimersByTime(4 * 60_000);
      expect(consumeAuthCode(code)).not.toBeNull(); // still inside the window

      const later = issueAuthCode(TEST_CLIENT, challenge);
      vi.advanceTimersByTime(6 * 60_000);
      expect(consumeAuthCode(later)).toBeNull(); // past the TTL
    } finally {
      vi.useRealTimers();
    }
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

  // Regression guard: expired-token housekeeping used to run on a 60s timer,
  // which kept the Neon compute from ever scaling to zero and eventually
  // exhausted the monthly compute allowance. The purge now happens on issuance.
  // See docs/plans/oauth-idle-compute-plan.md.
  it("purges already-expired tokens when a new one is issued", async () => {
    const expiredHash = sha256hex(`expired-${crypto.randomBytes(16).toString("hex")}`);
    await prisma.oAuthToken.create({
      data: {
        tokenHash: expiredHash,
        clientId: TEST_CLIENT,
        expiresAt: new Date(Date.now() - 60_000), // already expired
      },
    });
    createdTokenHashes.push(expiredHash); // belt-and-braces if the assertion fails

    const fresh = await issueRefreshToken(TEST_CLIENT);
    createdTokenHashes.push(sha256hex(fresh));

    // the expired row is gone …
    expect(await prisma.oAuthToken.findUnique({ where: { tokenHash: expiredHash } })).toBeNull();
    // … and the freshly issued one survived the purge and still works
    expect(await prisma.oAuthToken.findUnique({ where: { tokenHash: sha256hex(fresh) } })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth discovery metadata — must match what /token actually enforces
// ---------------------------------------------------------------------------

// The advertised client-auth method and the /token enforcement are two halves of
// one contract. They drifted once already: the metadata said "none" while /token
// required a client_secret, which only stayed invisible because the deployment's
// secret sat under an old variable name so the check never ran. A client that
// trusted the metadata would have failed the exchange.

describe("OAuth authorization-server metadata", () => {
  const httpSrc = readFileSync(new URL("../src/transports/http.ts", import.meta.url), "utf8");

  it("advertises client_secret_post, not none", () => {
    const advertised = httpSrc.match(
      /token_endpoint_auth_methods_supported:\s*\[([^\]]*)\]/,
    )?.[1];

    expect(advertised, "expected token_endpoint_auth_methods_supported in http.ts").toBeDefined();
    expect(advertised).toContain("client_secret_post");
    expect(advertised).not.toContain("none");
  });

  it("still enforces client_secret at /token", () => {
    // If this enforcement is ever removed, the metadata above becomes a lie in
    // the opposite direction — so the pair has to move together.
    expect(httpSrc).toMatch(/body\.client_secret\s*!==\s*requiredSecret/);
  });
});
