import { describe, expect, it } from "vitest";
import { parseEnv, toRecord } from "../src/index.js";

describe("env value store adoption examples", () => {
  it("parses local data without mutating process environment", () => {
    const before = process.env["MODE"];
    const parsed = parseEnv("MODE=test\n");
    expect(parsed.ok).toBe(true);
    expect(toRecord(parsed)).toEqual({ MODE: "test" });
    expect(process.env["MODE"]).toBe(before);
  });

  it("refuses non-env input and reports only location and code", () => {
    const parsed = parseEnv("name: service\n");
    expect(parsed.ok).toBe(false);
    expect(toRecord(parsed)).toBeNull();
    expect(parsed.findings).toEqual([{ line: 1, code: "NOT_ENV_LINE" }]);
  });
});
