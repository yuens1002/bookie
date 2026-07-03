import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConnectionUris, resolveOrgId, retry } from "./setup.js";

// Smoke-tests the *published* npm package end-to-end: installs bookie-mcp
// from the registry into a throwaway directory, pushes its bundled Prisma
// schema to a disposable Neon project, and confirms the server responds
// over stdio — the exact "no clone" flow documented in README.md. Runs in
// CI right after `npm publish`; the Neon project is always deleted after,
// pass or fail.

function run(cmd: string, cwd: string, extraEnv: Record<string, string> = {}): string {
  return execSync(cmd, {
    cwd,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, ...extraEnv },
  });
}

async function main(): Promise<void> {
  const rawVersion = process.env.PACKAGE_VERSION;
  if (!rawVersion) throw new Error("PACKAGE_VERSION is required (e.g. the just-published version)");
  if (!process.env.NEON_API_KEY) throw new Error("NEON_API_KEY is required (neonctl reads it automatically)");
  const version = rawVersion.replace(/^v/, "");

  const rootDir = process.cwd();
  const projectName = `bookie-verify-${Date.now()}`;

  // `neonctl projects create` requires an --org-id; without one it drops into
  // an interactive picker that hangs on a non-TTY CI runner — see setup.ts.
  const orgsRaw = run("npx neonctl orgs list --output json", rootDir);
  const orgId = resolveOrgId(orgsRaw, process.env.NEON_ORG_ID);

  console.log(`Creating disposable Neon project '${projectName}'...`);
  const raw = run(`npx neonctl projects create --name "${projectName}" --org-id "${orgId}" --output json`, rootDir);
  const projectId = (JSON.parse(raw) as { project: { id: string } }).project.id;
  const { pooled, direct } = parseConnectionUris(raw);
  const dbEnv = { BOOKIE_DB_URL: pooled, BOOKIE_DB_DIRECT_URL: direct };

  const workDir = mkdtempSync(join(tmpdir(), "bookie-verify-"));
  try {
    console.log(`Installing bookie-mcp@${version} into ${workDir}...`);
    await retry(
      () => run(`npm install bookie-mcp@${version}`, workDir),
      5,
      5000,
      (attempt, attempts) => console.log(`Install attempt ${attempt}/${attempts} failed (registry lag?) — retrying...`),
    );

    console.log("Pushing bundled schema to the disposable DB...");
    await retry(
      () => run("npx prisma db push --schema=node_modules/bookie-mcp/prisma/schema.prisma", workDir, dbEnv),
      5,
      4000,
      (attempt, attempts) =>
        console.log(`Schema push attempt ${attempt}/${attempts} failed (Neon compute may still be starting up) — retrying...`),
    );

    console.log("Starting the published server over stdio and listing its tools...");
    const toolsOutput = run(
      "npx @modelcontextprotocol/inspector --cli node node_modules/bookie-mcp/dist/index.js --method tools/list",
      workDir,
      { ...dbEnv, BOOKIE_API_KEY: "verify-smoke-test" },
    );

    if (!toolsOutput.includes("add_transaction")) {
      throw new Error(`Expected tools/list to include "add_transaction". Got:\n${toolsOutput}`);
    }
    console.log("bookie-mcp responded with the expected tools — published install verified.");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    console.log(`Deleting disposable Neon project '${projectId}'...`);
    try {
      execSync(`npx neonctl projects delete "${projectId}" --org-id "${orgId}"`, { stdio: "inherit" });
    } catch (err) {
      console.error(`Warning: failed to delete disposable project '${projectId}' — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error("Verify published install failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
