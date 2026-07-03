import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  // NodeNext source uses explicit ".js" import specifiers that point at ".ts"
  // files. Vite doesn't rewrite those by default, so map them during resolve.
  plugins: [
    {
      name: "bookie:js-to-ts",
      enforce: "pre",
      async resolveId(source, importer) {
        if (
          importer &&
          /\.[cm]?ts$/.test(importer) &&
          /^\.{1,2}\//.test(source) &&
          source.endsWith(".js")
        ) {
          const resolved = await this.resolve(
            `${source.slice(0, -3)}.ts`,
            importer,
            { skipSelf: true },
          );
          if (resolved) return resolved;
        }
        return null;
      },
    },
  ],
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // Neon round-trips (and cold starts) can exceed the 5s default.
    testTimeout: 30000,
    hookTimeout: 30000,
    // .claude/worktrees/** can hold full nested checkouts (agent worktree
    // isolation); vitest's defaults don't exclude .claude, so a stray one
    // silently double-runs the whole suite via its own copy of test/**.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
