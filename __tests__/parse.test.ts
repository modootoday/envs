import { describe, expect, it } from "vitest";

import { parseEnv, toRecord } from "../src/format/parse.js";

/**
 * Expected values are transcribed from a run of dotenv 17.4.2, not derived from
 * the parser, so an agreement here is between two independent readings.
 */
const DOTENV_17_4_2: ReadonlyArray<readonly [string, Record<string, string>]> =
  [
    ['K="a\\nb"', { K: "a\nb" }],
    ['K="a\\rb"', { K: "a\rb" }],
    ['K="a\\tb"', { K: "a\\tb" }],
    ['K="a\\\\b"', { K: "a\\\\b" }],
    ['K="C:\\path\\to"', { K: "C:\\path\\to" }],
    ['K="C:\\temp"', { K: "C:\\temp" }],
    ["K='a\\nb'", { K: "a\\nb" }],
    ["K='C:\\path\\to'", { K: "C:\\path\\to" }],
    ["K=`a\\nb`", { K: "a\\nb" }],
    ["K=a#b", { K: "a" }],
    ["K=a #c", { K: "a" }],
    ['K="a#b"', { K: "a#b" }],
    ["K=a=b", { K: "a=b" }],
    ["export K=v", { K: "v" }],
    ["api_key=secret", { api_key: "secret" }],
    ["a.b-c=v", { "a.b-c": "v" }],
    ['K="line1\nline2"', { K: "line1\nline2" }],
    ["K=", { K: "" }],
    ["  K  =  v  ", { K: "v" }],
  ];

describe("agrees with dotenv on valid env documents", () => {
  for (const [source, expected] of DOTENV_17_4_2) {
    it(JSON.stringify(source), () => {
      const result = parseEnv(source);
      expect(result.findings).toEqual([]);
      expect(toRecord(result)).toEqual(expected);
    });
  }
});

describe("rejects what dotenv silently accepts", () => {
  it("reads a YAML document as not env format", () => {
    const result = parseEnv("name: envs\nversion: 1\n");
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.code, f.line])).toEqual([
      ["NOT_ENV_LINE", 1],
      ["NOT_ENV_LINE", 2],
    ]);
    expect(toRecord(result)).toBeNull();
  });

  it("refuses a colon-separated pair", () => {
    expect(parseEnv("KEY: value").ok).toBe(false);
  });

  it("refuses a file containing an unterminated quote", () => {
    const result = parseEnv('A="oops\nB=fine\nC=also-fine\n');
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([{ code: "UNTERMINATED_QUOTE", line: 1 }]);
    expect(toRecord(result)).toBeNull();
  });

  it("loads nothing from a file with one bad line among good ones", () => {
    const result = parseEnv("A=1\nHELLO WORLD\nB=2\n");
    expect(result.findings).toEqual([{ code: "NOT_ENV_LINE", line: 2 }]);
    expect(toRecord(result)).toBeNull();
  });
});

describe("classifies the three kinds", () => {
  it("counts comments and blanks as entries", () => {
    const result = parseEnv("# a comment\n\nK=v\n");
    expect(result.ok).toBe(true);
    expect(result.entries.map((e) => e.kind)).toEqual([
      "comment",
      "blank",
      "assignment",
    ]);
  });

  it("treats an indented comment as a comment", () => {
    expect(parseEnv("   # indented\n").entries[0]?.kind).toBe("comment");
  });

  it("reports the span of a multiline value", () => {
    const result = parseEnv('K="one\ntwo\nthree"\nJ=1\n');
    expect(result.ok).toBe(true);
    const [first, second] = result.entries;
    expect([first?.line, first?.endLine]).toEqual([1, 3]);
    expect([second?.line, second?.endLine]).toEqual([4, 4]);
  });

  it("records the quote style and the export form", () => {
    const result = parseEnv("export A='x'\nB=y\n");
    expect(result.entries[0]).toMatchObject({ quote: "'", exported: true });
    expect(result.entries[1]).toMatchObject({ quote: null, exported: false });
  });
});

describe("key rules", () => {
  it("accepts lowercase and dotted keys", () => {
    expect(parseEnv("a.b-c_D=1\n").ok).toBe(true);
  });

  it("rejects a key with a space inside", () => {
    expect(parseEnv("a b=c\n").findings).toEqual([
      { code: "INVALID_KEY", line: 1 },
    ]);
  });

  it("rejects an empty key", () => {
    expect(parseEnv("=v\n").findings).toEqual([{ code: "EMPTY_KEY", line: 1 }]);
  });
});

describe("line endings and trailing content", () => {
  it("normalises CRLF", () => {
    expect(toRecord(parseEnv("A=1\r\nB=2\r\n"))).toEqual({ A: "1", B: "2" });
  });

  it("allows a comment after a quoted value", () => {
    expect(toRecord(parseEnv('A="v" # note\n'))).toEqual({ A: "v" });
  });

  it("rejects content after a closing quote", () => {
    expect(parseEnv('A="v" junk\n').findings).toEqual([
      { code: "TRAILING_CONTENT", line: 1 },
    ]);
  });
});

describe("findings never carry values", () => {
  it("keeps secrets out of the finding shape", () => {
    const result = parseEnv('SECRET="s3cr3t\nOTHER=v\n');
    const serialised = JSON.stringify(result.findings);
    expect(serialised).not.toContain("s3cr3t");
    expect(Object.keys(result.findings[0]!).sort()).toEqual(["code", "line"]);
  });
});
