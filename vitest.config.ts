import { defineConfig } from "vitest/config";

export default defineConfig({
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
