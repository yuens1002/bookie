import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Railway's one-click template auto-detects the public domain's target port
// from EXPOSE. If it drifts from the runtime PORT, every request 502s
// ("Application failed to respond") even though the container is healthy —
// see the Dockerfile comment and CHANGELOG v0.8.2 for the incident this guards.

describe("Dockerfile", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

  it("keeps runtime ENV PORT and EXPOSE in sync", () => {
    const envPort = dockerfile.match(/^ENV PORT=(\d+)$/m)?.[1];
    const exposePort = dockerfile.match(/^EXPOSE (\d+)$/m)?.[1];

    expect(envPort, "expected `ENV PORT=<port>` in the runtime stage").toBeDefined();
    expect(exposePort, "expected `EXPOSE <port>` in the runtime stage").toBeDefined();
    expect(exposePort).toBe(envPort);
  });
});
