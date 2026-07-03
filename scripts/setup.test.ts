import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  checkNeonctl,
  generateSecrets,
  parseConnectionUris,
  buildEnvContent,
  parseEnvFile,
  resolveOrgId,
  findExistingProject,
  retry,
} from "./setup.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
  execSync: vi.fn(),
}));

const NEON_FIXTURE = JSON.stringify({
  project: { id: "silent-term-12345" },
  connection_uris: [
    {
      connection_uri:
        "postgresql://neondb_owner:s3cr3t@ep-cool-dark.us-east-2.aws.neon.tech/neondb?sslmode=require",
      connection_parameters: {
        database: "neondb",
        role: "neondb_owner",
        host: "ep-cool-dark.us-east-2.aws.neon.tech",
        pooler_host: "ep-cool-dark-pooler.us-east-2.aws.neon.tech",
        password: "s3cr3t",
      },
    },
  ],
});

describe("generateSecrets", () => {
  it("BOOKIE_API_KEY is a 64-char hex string", () => {
    expect(generateSecrets().BOOKIE_API_KEY).toMatch(/^[0-9a-f]{64}$/);
  });

  it("JWT_SECRET is a 64-char hex string", () => {
    expect(generateSecrets().JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  it("OAUTH_CLIENT_SECRET is base64url with length ≥ 32", () => {
    const { OAUTH_CLIENT_SECRET } = generateSecrets();
    expect(OAUTH_CLIENT_SECRET).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(OAUTH_CLIENT_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it("generates unique values on each call", () => {
    expect(generateSecrets().BOOKIE_API_KEY).not.toBe(generateSecrets().BOOKIE_API_KEY);
  });
});

describe("parseConnectionUris", () => {
  it("direct URL is the original connection_uri", () => {
    const { direct } = parseConnectionUris(NEON_FIXTURE);
    expect(direct).toBe(
      "postgresql://neondb_owner:s3cr3t@ep-cool-dark.us-east-2.aws.neon.tech/neondb?sslmode=require",
    );
  });

  it("pooled URL starts with postgresql://", () => {
    const { pooled } = parseConnectionUris(NEON_FIXTURE);
    expect(pooled).toMatch(/^postgresql:\/\//);
  });

  it("pooled URL host contains -pooler", () => {
    const { pooled } = parseConnectionUris(NEON_FIXTURE);
    expect(pooled).toContain("-pooler");
  });

  it("pooled URL does not use the direct host", () => {
    const { pooled } = parseConnectionUris(NEON_FIXTURE);
    expect(pooled).not.toContain("ep-cool-dark.us-east-2.aws.neon.tech/");
  });
});

describe("parseEnvFile", () => {
  it("parses non-empty KEY=value lines", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips empty values (KEY=)", () => {
    const result = parseEnvFile("FOO=\nBAR=hello");
    expect(result).toEqual({ BAR: "hello" });
  });

  it("skips comment lines", () => {
    const result = parseEnvFile("# comment\nFOO=bar");
    expect(result).toEqual({ FOO: "bar" });
  });
});

describe("buildEnvContent", () => {
  const template = ["# DB", "BOOKIE_DB_URL=", "BOOKIE_API_KEY=", "JWT_SECRET=some"].join("\n");

  it("fills empty keys from overrides", () => {
    const out = buildEnvContent(template, { BOOKIE_DB_URL: "postgres://x", BOOKIE_API_KEY: "abc" });
    expect(out).toContain("BOOKIE_DB_URL=postgres://x");
    expect(out).toContain("BOOKIE_API_KEY=abc");
  });

  it("overwrites existing template values when override provided", () => {
    const out = buildEnvContent(template, { JWT_SECRET: "newvalue" });
    expect(out).toContain("JWT_SECRET=newvalue");
    expect(out).not.toContain("JWT_SECRET=some");
  });

  it("preserves lines with no matching override key", () => {
    const out = buildEnvContent(template, {});
    expect(out).toContain("# DB");
    expect(out).toContain("JWT_SECRET=some");
  });

  it("substitutes values in a CRLF-terminated template (Windows git checkout)", () => {
    // Regression: git on Windows checks .env.example out with CRLF by default.
    // A naive split("\n") leaves a trailing "\r" on every line, and "." doesn't
    // match "\r" — the per-line regex used to silently fail to match ANY line,
    // so every generated secret/URL came back as the raw, unmodified template.
    const crlfTemplate = template.split("\n").join("\r\n");
    const out = buildEnvContent(crlfTemplate, { BOOKIE_DB_URL: "postgres://real-value" });
    expect(out).toContain("BOOKIE_DB_URL=postgres://real-value");
    expect(out).not.toContain("BOOKIE_DB_URL=\r");
  });

  it("idempotency: when existing .env values are passed as overrides, they are preserved", () => {
    // Simulate second run: existing BOOKIE_DB_URL wins via { ...generated, ...existing }
    const overrides = {
      BOOKIE_DB_URL: "postgres://existing",  // existing wins over generated
      BOOKIE_API_KEY: "generated-key",
    };
    const out = buildEnvContent(template, overrides);
    expect(out).toContain("BOOKIE_DB_URL=postgres://existing");
    expect(out).toContain("BOOKIE_API_KEY=generated-key");
  });
});

describe("resolveOrgId", () => {
  it("returns the envOverride without touching the orgs list", () => {
    expect(resolveOrgId("not valid json", "org-explicit")).toBe("org-explicit");
  });

  it("auto-selects the single org when exactly one exists", () => {
    const raw = JSON.stringify([{ id: "org-solo-123", name: "sunny@yuens.me" }]);
    expect(resolveOrgId(raw)).toBe("org-solo-123");
  });

  it("throws with NEON_ORG_ID guidance when multiple orgs exist", () => {
    const raw = JSON.stringify([
      { id: "org-a", name: "personal" },
      { id: "org-b", name: "work" },
    ]);
    expect(() => resolveOrgId(raw)).toThrow(/NEON_ORG_ID/);
  });

  it("throws when the account has no orgs at all", () => {
    expect(() => resolveOrgId("[]")).toThrow(/No Neon organizations/);
  });
});

describe("findExistingProject", () => {
  const projects = JSON.stringify([
    { id: "lucky-term-1", name: "bookie", created_at: "2026-06-03T00:00:00Z" },
    { id: "square-silence-2", name: "brew-guide", created_at: "2026-05-26T00:00:00Z" },
  ]);

  it("finds a project matching the given name", () => {
    const found = findExistingProject(projects, "bookie");
    expect(found?.id).toBe("lucky-term-1");
  });

  it("returns undefined when no project matches", () => {
    expect(findExistingProject(projects, "bookie-rentals")).toBeUndefined();
  });

  it("returns undefined for an empty projects list", () => {
    expect(findExistingProject("[]", "bookie")).toBeUndefined();
  });
});

describe("retry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn(() => "ok");
    await expect(retry(fn, 3, 0)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries after failures and returns once it succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });
    await expect(retry(fn, 5, 0)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the underlying error after exhausting all attempts", async () => {
    const fn = vi.fn(() => {
      throw new Error("permanent");
    });
    await expect(retry(fn, 3, 0)).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls onRetry once per failed attempt, not on the final throw", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn(() => {
      throw new Error("permanent");
    });
    await expect(retry(fn, 3, 0, onRetry)).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 3);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 3);
  });
});

describe("checkNeonctl", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("does not throw when neonctl is available", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      error: undefined,
      signal: null,
      output: [],
      pid: 123,
      stderr: Buffer.from(""),
      stdout: Buffer.from("neonctl/0.0.0"),
    });
    expect(() => checkNeonctl()).not.toThrow();
  });

  it("throws with 'neonctl' in the message when spawn fails with ENOENT", () => {
    const enoent = Object.assign(new Error("spawn neonctl ENOENT"), { code: "ENOENT" });
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      error: enoent,
      signal: null,
      output: [],
      pid: 0,
      stderr: Buffer.from(""),
      stdout: Buffer.from(""),
    });
    expect(() => checkNeonctl()).toThrow(/neonctl/);
  });

  it("throws with install instruction when status is non-zero", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 127,
      error: undefined,
      signal: null,
      output: [],
      pid: 0,
      stderr: Buffer.from("command not found"),
      stdout: Buffer.from(""),
    });
    expect(() => checkNeonctl()).toThrow(/neonctl/);
  });
});
