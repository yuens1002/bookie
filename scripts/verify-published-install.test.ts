import { describe, it, expect } from "vitest";
import { buildInspectorEnvFlags, shellQuote } from "./verify-published-install.js";

// The published-install smoke test hands the server its environment through the
// inspector's `-e` flags, because the inspector does not pass its own environment
// to the process it spawns (its `-e` default is `{}`). Two things can silently
// break that: dropping the flags, and shell metacharacters in a connection string
// mangling the command. Both produce a "misconfigured env" error that looks
// nothing like a quoting bug — see #56.

describe("shellQuote", () => {
  it("wraps a value in single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
  });

  it("protects the & and ? that every Neon connection string contains", () => {
    const url = "postgresql://u:p@ep-a.neon.tech/neondb?sslmode=require&channel_binding=require";
    const quoted = shellQuote(url);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // the metacharacters survive inside the quotes rather than reaching the shell
    expect(quoted).toContain("?sslmode=require&channel_binding=require");
  });

  it("does not let a $ expand", () => {
    // single quotes are literal in POSIX sh, so $HOME stays $HOME
    expect(shellQuote("pa$$word")).toBe("'pa$$word'");
  });

  it("escapes an embedded single quote", () => {
    // ' -> '\'' — close, escaped literal quote, reopen
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("buildInspectorEnvFlags", () => {
  it("emits one -e flag per variable", () => {
    const flags = buildInspectorEnvFlags({ A: "1", B: "2" });
    expect(flags).toBe("-e 'A=1' -e 'B=2'");
  });

  it("keeps KEY=VALUE inside one quoted argument", () => {
    // The whole pair must be a single argv entry; quoting only the value would
    // split on the metacharacters in the URL.
    const url = "postgresql://u:p@ep-a.neon.tech/db?sslmode=require&x=1";
    expect(buildInspectorEnvFlags({ BOOKIE_DB_URL: url })).toBe(`-e 'BOOKIE_DB_URL=${url}'`);
  });

  it("returns an empty string for no variables", () => {
    expect(buildInspectorEnvFlags({})).toBe("");
  });
});
