import crypto from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- Types ------------------------------------------------------------------

interface NeonConnectionParameters {
  database: string;
  role: string;
  host: string;
  pooler_host: string;
  password: string;
}

interface NeonCreateOutput {
  project: { id: string };
  connection_uris?: Array<{
    connection_uri: string;
    connection_parameters: NeonConnectionParameters;
  }>;
}

export interface ConnectionUris {
  direct: string;
  pooled: string;
}

export interface Secrets {
  BOOKIE_API_KEY: string;
  JWT_SECRET: string;
  OAUTH_CLIENT_SECRET: string;
}

// --- Pure helpers (exported for testing) ------------------------------------

export function checkNeonctl(): void {
  const result = spawnSync("neonctl", ["--version"], { stdio: "pipe", shell: true });
  if (result.error || result.status !== 0) {
    throw new Error(
      "neonctl is not installed or not on PATH.\n" +
      "Install it with: npm install -g neonctl\n" +
      "Then log in with: neonctl auth",
    );
  }
}

export function parseConnectionUris(json: string): ConnectionUris {
  const data = JSON.parse(json) as NeonCreateOutput;
  const entry = data.connection_uris?.[0];
  if (!entry) throw new Error("neonctl response missing connection_uris — the project may not have been created; check neonctl output");
  const { connection_uri, connection_parameters: p } = entry;
  return {
    direct: connection_uri,
    pooled: connection_uri.replace(`@${p.host}/`, `@${p.pooler_host}/`),
  };
}

// `neonctl projects create` requires an --org-id; without one it drops into
// an interactive picker that hangs when stdout isn't a real TTY (always true
// under execSync) — every brand-new account hits this, since a fresh account
// has no cached "current org" to fall back on.
export function resolveOrgId(rawOrgsJson: string, envOverride?: string): string {
  if (envOverride) return envOverride;
  const orgs = JSON.parse(rawOrgsJson) as Array<{ id: string; name: string }>;
  if (orgs.length === 0) {
    throw new Error(
      "No Neon organizations found for this account — every authenticated Neon account should have at least a personal org.",
    );
  }
  if (orgs.length > 1) {
    const list = orgs.map((o) => `  ${o.id}  (${o.name})`).join("\n");
    throw new Error(`Multiple Neon organizations found — set NEON_ORG_ID to pick one:\n${list}`);
  }
  const org = orgs[0];
  if (!org) throw new Error("neonctl orgs list returned an empty entry");
  return org.id;
}

export interface NeonProjectSummary {
  id: string;
  name: string;
  created_at: string;
}

// Neon allows multiple projects with the same name in one org — creating
// "bookie" a second time silently succeeds with a distinct project id, no
// error, no warning. Check first so a re-run (deliberate second ledger, or
// an accidental re-run after losing .env) doesn't produce two same-named,
// hard-to-tell-apart projects.
export function findExistingProject(
  rawProjectsJson: string,
  name: string,
): NeonProjectSummary | undefined {
  const projects = JSON.parse(rawProjectsJson) as NeonProjectSummary[];
  return projects.find((p) => p.name === name);
}

// Generic retry for flaky external steps (npm registry replication lag,
// Neon compute cold-start on a just-created project — see vitest.config.ts's
// testTimeout comment for the same underlying Neon characteristic).
export async function retry<T>(
  fn: () => T,
  attempts: number,
  delayMs: number,
  onRetry?: (attempt: number, attempts: number) => void,
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt === attempts) throw err;
      onRetry?.(attempt, attempts);
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw new Error("unreachable");
}

export function generateSecrets(): Secrets {
  return {
    BOOKIE_API_KEY: crypto.randomBytes(32).toString("hex"),
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    OAUTH_CLIENT_SECRET: crypto.randomBytes(24).toString("base64url"),
  };
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && m[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

export function buildEnvContent(
  template: string,
  overrides: Record<string, string>,
): string {
  // Normalize CRLF before splitting: on Windows, git checks .env.example out
  // with CRLF by default, and a plain split("\n") leaves a trailing "\r" on
  // every line. "." doesn't match "\r" and "$" requires true end-of-string,
  // so the line regex below silently fails to match ANY line — every value
  // (secrets, DB URLs, all of it) would come back as the unmodified template.
  return template
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=.*$/);
      if (!m || !m[1]) return line;
      const value = overrides[m[1]];
      return value !== undefined ? `${m[1]}=${value}` : line;
    })
    .join("\n");
}

// --- Orchestrator -----------------------------------------------------------

async function main(): Promise<void> {
  try {
    checkNeonctl();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const envPath = resolve(rootDir, ".env");
  const examplePath = resolve(rootDir, ".env.example");

  // Read existing .env — preserve any already-set values (idempotency)
  const existing = existsSync(envPath)
    ? parseEnvFile(readFileSync(envPath, "utf8"))
    : {};

  // Create Neon project only if both DB URLs are absent; error on partial config
  const hasDbUrl = !!existing["BOOKIE_DB_URL"];
  const hasDbDirect = !!existing["BOOKIE_DB_DIRECT_URL"];
  if (hasDbUrl !== hasDbDirect) {
    console.error(
      "Partial DB config: exactly one of BOOKIE_DB_URL / BOOKIE_DB_DIRECT_URL is set.\n" +
      "Either set both (to keep an existing DB) or clear both (to let setup create a new one).",
    );
    process.exit(1);
  }

  let dbUrls: ConnectionUris | undefined;
  if (!hasDbUrl && !hasDbDirect) {
    console.log("\nAuthenticating with Neon (browser will open if not already logged in)...");
    execSync("neonctl auth", { stdio: "inherit" });

    const orgsRaw = execSync("neonctl orgs list --output json", { encoding: "utf8" });
    const orgId = resolveOrgId(orgsRaw, process.env.NEON_ORG_ID);

    const projectName = process.env.NEON_PROJECT_NAME || "bookie";
    const projectsRaw = execSync(`neonctl projects list --org-id ${orgId} --output json`, { encoding: "utf8" });
    const collision = findExistingProject(projectsRaw, projectName);
    if (collision) {
      console.error(
        `A Neon project named '${projectName}' already exists (id: ${collision.id}, created ${collision.created_at}).\n` +
        "Neon allows duplicate names, so creating another would succeed but leave two easily-confused same-named projects.\n\n" +
        "To connect to the EXISTING project instead: set BOOKIE_DB_URL / BOOKIE_DB_DIRECT_URL in .env yourself " +
        "(copy its connection strings from the Neon console) rather than running setup.\n" +
        "To deliberately create a SECOND, independent ledger: re-run with a distinct name, e.g. " +
        "NEON_PROJECT_NAME=bookie-rentals npm run setup",
      );
      process.exit(1);
    }

    console.log(`Creating Neon project '${projectName}'...`);
    const raw = execSync(`neonctl projects create --name ${projectName} --org-id ${orgId} --output json`, {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
    });
    dbUrls = parseConnectionUris(raw);
    console.log("Neon project created.");
  } else {
    console.log("Neon DB already configured — skipping project creation.");
  }

  const fresh = generateSecrets();

  // Merge: generated values as defaults, existing non-empty values win
  const generated: Record<string, string> = {
    ...(dbUrls
      ? { BOOKIE_DB_URL: dbUrls.pooled, BOOKIE_DB_DIRECT_URL: dbUrls.direct }
      : {}),
    BOOKIE_API_KEY: fresh.BOOKIE_API_KEY,
    JWT_SECRET: fresh.JWT_SECRET,
    OAUTH_CLIENT_SECRET: fresh.OAUTH_CLIENT_SECRET,
  };
  const overrides: Record<string, string> = { ...generated, ...existing };

  const template = readFileSync(examplePath, "utf8");
  writeFileSync(envPath, buildEnvContent(template, overrides), "utf8");
  console.log(".env written.");

  console.log("\nApplying schema to database...");
  await retry(
    () => execSync("npx prisma db push", { stdio: "inherit", cwd: rootDir }),
    5,
    4000,
    (attempt, attempts) =>
      console.log(`Schema push attempt ${attempt}/${attempts} failed (Neon compute may still be starting up) — retrying...`),
  );

  const apiKey = overrides["BOOKIE_API_KEY"] ?? "";
  const dbUrl = overrides["BOOKIE_DB_URL"] ?? "";
  const dbDirect = overrides["BOOKIE_DB_DIRECT_URL"] ?? "";
  const distPath = resolve(rootDir, "dist/index.js");

  console.log(`
Setup complete!

Add this to your Claude Desktop config (claude_desktop_config.json):

{
  "mcpServers": {
    "bookie": {
      "command": "node",
      "args": ["${distPath}"],
      "env": {
        "BOOKIE_DB_URL": "${dbUrl}",
        "BOOKIE_DB_DIRECT_URL": "${dbDirect}",
        "BOOKIE_API_KEY": "${apiKey}"
      }
    }
  }
}

Next step: npm run build
`);
}

// Only auto-run when executed directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("Setup failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
