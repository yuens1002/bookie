import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainModule, parseConnectionUris, resolveOrgId, retry } from "./setup.js";

// Smoke-tests the *published* npm package end-to-end: installs bookie-mcp
// from the registry into a throwaway directory, pushes its bundled Prisma
// schema to a disposable Neon project, and confirms the server responds
// over stdio — the exact "no clone" flow documented in README.md. Runs in
// CI right after `npm publish`; the Neon project is always deleted after,
// pass or fail.

// Pinned deliberately. The inspector's CLI is the contract this smoke test depends
// on, and an unpinned `npx` silently crossed v1 → v2 between releases: v2 no longer
// gives the spawned server the parent environment, so the published server started
// with no BOOKIE_DB_URL and every release after the bump would have failed (#56).
const INSPECTOR_VERSION = "2.1.0";

/**
 * POSIX single-quote escaping. Connection strings contain `?` and `&`, and may
 * contain `$` — all of which /bin/sh would interpret inside an unquoted or
 * double-quoted argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `-e KEY=VALUE` flags for the inspector CLI.
 *
 * The inspector does not pass its own environment to the server it spawns — its
 * `-e` default is `{}`. This mirrors how MCP clients declare a server's `env`
 * block explicitly rather than leaking the parent's environment into every
 * third-party server. So exporting these vars for the inspector process is not
 * enough; they have to be declared here to reach the server.
 */
export function buildInspectorEnvFlags(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`)
    .join(" ");
}

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
    const serverEnv = { ...dbEnv, BOOKIE_API_KEY: "verify-smoke-test" };
    const toolsOutput = run(
      `npx -y @modelcontextprotocol/inspector@${INSPECTOR_VERSION} --cli ` +
        "node node_modules/bookie-mcp/dist/index.js --method tools/list " +
        buildInspectorEnvFlags(serverEnv),
      workDir,
      serverEnv,
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

// Only run when invoked directly — importing this module (the unit tests import
// its pure helpers) must not kick off a real Neon project + npm install.
// Same guard as scripts/setup.ts.
if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("Verify published install failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
