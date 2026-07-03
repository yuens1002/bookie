import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The MCP Registry cross-checks server.json against the published npm
// package: `server.json`'s `name` must equal `package.json`'s `mcpName`,
// and the npm package entry's `identifier` must equal `package.json`'s
// `name`. A drift here fails silently until the next `mcp-publisher
// publish` — this guards it at `npm test` time instead.

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));

describe("server.json", () => {
  it("`name` matches package.json's `mcpName`", () => {
    expect(server.name).toBe(pkg.mcpName);
  });

  it("npm package identifier matches package.json's `name`", () => {
    const npmPackage = server.packages.find((p: { registryType: string }) => p.registryType === "npm");
    expect(npmPackage?.identifier).toBe(pkg.name);
  });
});
