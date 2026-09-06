import { defineConfig } from "tsup";

export default defineConfig({
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
