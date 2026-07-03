import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Railway's one-click template auto-detects the public domain's target port
// from EXPOSE. If it drifts from the runtime PORT, every request 502s
// ("Application failed to respond") even though the container is healthy —
// see the Dockerfile comment and CHANGELOG v0.8.2 for the incident this guards.

describe("Dockerfile", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

  // Scoped to the runtime stage specifically — matching anywhere in the file
  // would let a PORT/EXPOSE pair added to the build stage (or a second
  // EXPOSE) satisfy the regex while the runtime stage silently drifts.
  const stages = dockerfile.split(/^(?=FROM )/m);
  const runtimeStage = stages.find((stage) => /^FROM .*\bAS\s+runtime\b/im.test(stage));

  it("has a `FROM ... AS runtime` stage", () => {
    expect(runtimeStage, "expected a `FROM <image> AS runtime` stage in the Dockerfile").toBeDefined();
  });

  it("keeps runtime ENV PORT and EXPOSE in sync", () => {
    const envPort = runtimeStage?.match(/^ENV PORT=(\d+)$/m)?.[1];
    const exposePort = runtimeStage?.match(/^EXPOSE (\d+)$/m)?.[1];

    expect(envPort, "expected `ENV PORT=<port>` in the runtime stage").toBeDefined();
    expect(exposePort, "expected `EXPOSE <port>` in the runtime stage").toBeDefined();
    expect(exposePort).toBe(envPort);
  });
});
