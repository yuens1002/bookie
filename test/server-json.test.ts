import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The MCP Registry cross-checks server.json against the published npm
// package: `server.json`'s `name` must equal `package.json`'s `mcpName`,
// and the npm package entry's `identifier` must equal `package.json`'s
// `name`. A drift here fails silently until the next `mcp-publisher
// publish` — this guards it at `npm test` time instead.
//
// server.json's version is checked against CHANGELOG.md's latest *released*
// version, not package.json's — package.json bumps on every PR (this
// project's per-PR convention), so it's usually ahead of whatever's
// actually live on npm. server.json must reference a version the registry
// can find published, so the last dated CHANGELOG entry (written only by
// `/release`) is the correct source of truth, not package.json's current,
// often-unreleased value.

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lastReleasedVersion = changelog.match(/^## \[(\d+\.\d+\.\d+)\] — /m)?.[1];

describe("server.json", () => {
  it("`name` matches package.json's `mcpName`", () => {
    expect(server.name).toBe(pkg.mcpName);
  });

  it("npm package identifier matches package.json's `name`", () => {
    const npmPackage = server.packages.find((p: { registryType: string }) => p.registryType === "npm");
    expect(npmPackage?.identifier).toBe(pkg.name);
  });

  it("top-level `version` matches CHANGELOG.md's latest released version", () => {
    expect(lastReleasedVersion, "expected a `## [X.Y.Z] — date` heading in CHANGELOG.md").toBeDefined();
    expect(server.version).toBe(lastReleasedVersion);
  });

  it("npm package entry's `version` matches CHANGELOG.md's latest released version", () => {
    expect(lastReleasedVersion, "expected a `## [X.Y.Z] — date` heading in CHANGELOG.md").toBeDefined();
    const npmPackage = server.packages.find((p: { registryType: string }) => p.registryType === "npm");
    expect(npmPackage?.version).toBe(lastReleasedVersion);
  });
});
