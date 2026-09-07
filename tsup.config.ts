import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

// Baked in rather than read at runtime: the built artifact then carries the
// version it was built from, so a stale dist cannot claim the manifest's.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __ENVS_VERSION__: JSON.stringify(version) },
  entry: {
    index: "src/index.ts",
    config: "src/config.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: true,
  minify: false,
  sourcemap: false,
  treeshake: false,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
