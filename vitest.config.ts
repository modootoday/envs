import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// The same substitution the build makes, from the same file, so a test cannot
// pass against a version the shipped artifact would never report.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __ENVS_VERSION__: JSON.stringify(version) },
  test: {
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    // Sequential on purpose: the suite opens real sqlite files in temp
    // directories, and three sqlite backends do not agree about locking.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
