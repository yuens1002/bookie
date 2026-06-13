import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";

// Tests use year 2024 to avoid date collisions with other suites (2025=tax, 2026=others).

let client: Client;

function errText(res: CallToolResult): string {
  const block = res.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return block.text;
}

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-send-report", version: "0.0.0" });
  const server = buildServer();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe("send_report — type-scoped parameter validation", () => {
  it("rejects monthly-reconciliation without month", async () => {
    const res = (await client.callTool({
      name: "send_report",
      arguments: { type: "monthly-reconciliation", year: 2024, to: "test@example.com" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(errText(res)).toContain("month is required");
  });

  it("rejects schedule-c with month", async () => {
    const res = (await client.callTool({
      name: "send_report",
      arguments: { type: "schedule-c", year: 2024, month: 3, to: "test@example.com" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(errText(res)).toContain("month must not be supplied");
  });

  it("rejects schedule-e with month", async () => {
    const res = (await client.callTool({
      name: "send_report",
      arguments: { type: "schedule-e", year: 2024, month: 6, to: "test@example.com" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(errText(res)).toContain("month must not be supplied");
  });

  it("rejects schedule-c with accountId", async () => {
    const res = (await client.callTool({
      name: "send_report",
      arguments: { type: "schedule-c", year: 2024, accountId: "acc_fake", to: "test@example.com" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(errText(res)).toContain("accountId is not applicable");
  });

  it("rejects schedule-e with accountId", async () => {
    const res = (await client.callTool({
      name: "send_report",
      arguments: { type: "schedule-e", year: 2024, accountId: "acc_fake", to: "test@example.com" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(errText(res)).toContain("accountId is not applicable");
  });
});

describe("send_report — missing env vars", () => {
  it("fails when RESEND_API_KEY is not set", async () => {
    const orig = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const res = (await client.callTool({
        name: "send_report",
        arguments: { type: "schedule-c", year: 2024, to: "test@example.com" },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect(errText(res)).toContain("RESEND_API_KEY");
    } finally {
      if (orig !== undefined) process.env.RESEND_API_KEY = orig;
    }
  });

  it("fails when RESEND_FROM is not set", async () => {
    const origKey = process.env.RESEND_API_KEY;
    const origFrom = process.env.RESEND_FROM;
    process.env.RESEND_API_KEY = "re_test_placeholder";
    delete process.env.RESEND_FROM;
    try {
      const res = (await client.callTool({
        name: "send_report",
        arguments: { type: "schedule-c", year: 2024, to: "test@example.com" },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect(errText(res)).toContain("RESEND_FROM");
    } finally {
      if (origKey !== undefined) process.env.RESEND_API_KEY = origKey;
      else delete process.env.RESEND_API_KEY;
      if (origFrom !== undefined) process.env.RESEND_FROM = origFrom;
    }
  });
});

/*
 * Manual smoke-test for D2 (rate limiting + audit logging) — automated tests
 * are skipped because they require a live HTTP server with the @hono/node-server
 * bindings that the InMemoryTransport does not provide.
 *
 * To verify D2 manually:
 *   1. npm run dev:http
 *   2. Send > RATE_LIMIT_RPM requests within 60s to /mcp — expect 429 on excess.
 *   3. Inspect stderr — each request should emit a JSON audit line:
 *      {"ts":"…","ip":"…","method":"…","toolName":"…"}
 */
