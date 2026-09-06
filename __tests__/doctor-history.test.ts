import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Ui, type Stream } from "../src/cli/ui.js";
import { dispatch } from "../src/commands/index.js";
import { config } from "../src/loader/config.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const KEK = Buffer.from(new Uint8Array(32).fill(31)).toString("base64");

let dir: string;
let home: string;
let out: Capture;
let err: Capture;

function run(argv: readonly string[], cwd = dir): number {
  out = new Capture();
  err = new Capture();
  return dispatch(argv, {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env: { ENVS_KEK: KEK },
    cwd,
  });
}

const load = (): ReturnType<typeof config> =>
  config({ cwd: dir, home, env: { ENVS_KEK: KEK }, processEnv: {} });

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "envs-doc-"));
  dir = join(base, "project");
  home = join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  run(["init", "--recovery-codes", "1"]);
  writeFileSync(join(dir, ".env"), "A=1\nB=2\n");
  run(["load", ".env"]);
});

afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("history", () => {
  it("lists releases newest first and marks the current one", () => {
    run(["set", "A=second"]);
    expect(run(["history"])).toBe(0);
    const lines = err.text
      .split("\n")
      .filter((line) => line.includes("values"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain("*");
    expect(lines[1]).not.toMatch(/^ {2}\*/);
  });

  it("says what to do when nothing has been released", () => {
    const empty = join(dir, "..", "empty");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "package.json"), "{}\n");
    run(["init", "--recovery-codes", "0"], empty);
    expect(run(["history"], empty)).toBe(0);
    expect(err.text).toContain("no releases yet");
  });

  it("refuses a limit that is not a positive whole number", () => {
    expect(run(["history", "--limit", "0"])).toBe(2);
  });
});

describe("rollback", () => {
  it("returns the earlier values by moving the pointer", () => {
    run(["set", "A=second"]);
    expect(load().parsed?.["A"]).toBe("second");

    run(["history"]);
    const ids = [...err.text.matchAll(/[* ] ([0-9a-f]{8})/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    expect(run(["rollback", ids[1]!])).toBe(0);
    expect(load().parsed?.["A"]).toBe("1");
  });

  it("leaves the release it came from in place, so it is reversible", () => {
    run(["set", "A=second"]);
    run(["history"]);
    const ids = [...err.text.matchAll(/[* ] ([0-9a-f]{8})/g)].map((m) => m[1]!);
    run(["rollback", ids[1]!]);
    expect(run(["rollback", ids[0]!])).toBe(0);
    expect(load().parsed?.["A"]).toBe("second");
  });

  it("refuses an id that matches nothing", () => {
    expect(run(["rollback", "ffffffff"])).toBe(1);
    expect(err.text).toContain("no release starting with");
  });

  it("says so when already there rather than writing", () => {
    run(["history"]);
    const current = /\* ([0-9a-f]{8})/.exec(err.text)?.[1];
    expect(run(["rollback", current!])).toBe(0);
    expect(err.text).toContain("already current");
  });
});

describe("doctor", () => {
  it("names the catalogs it read", () => {
    expect(run(["doctor"])).toBe(0);
    expect(err.text).toContain(join(dir, ".envs", "catalog.sqlite"));
    expect(err.text).toContain("global");
  });

  it("reports a clean catalog as clean", () => {
    expect(run(["doctor"])).toBe(0);
    expect(err.text).toContain("nothing to report");
  });

  it("errors when two sources give a key different values", () => {
    writeFileSync(join(dir, "other.env"), "A=different\n");
    run(["load", "other.env"]);
    expect(run(["doctor"])).toBe(1);
    expect(err.text).toContain("values differ");
    expect(err.text).not.toContain("different");
  });

  it("warns rather than errors when the two values are the same", () => {
    writeFileSync(join(dir, "other.env"), "A=1\n");
    run(["load", "other.env"]);
    expect(run(["doctor"])).toBe(0);
    expect(err.text).toContain("same value");
  });

  it("reports a source whose file has gone", () => {
    unlinkSync(join(dir, ".env"));
    run(["doctor"]);
    expect(err.text).toContain("is gone");
  });

  it("errors when the catalog is not ignored by git", () => {
    unlinkSync(join(dir, ".gitignore"));
    expect(run(["doctor"])).toBe(1);
    expect(err.text).toContain("not ignored by git");
  });

  it("answers for one key without printing its value", () => {
    expect(run(["doctor", "--key", "A"])).toBe(0);
    expect(err.text).toContain("project:env");
    expect(err.text).toContain("* wins");
    expect(err.text).not.toMatch(/\b1\b.*value/);
  });

  it("says plainly when a key is declared nowhere", () => {
    expect(run(["doctor", "--key", "MISSING"])).toBe(1);
    expect(err.text).toContain("no source declares MISSING");
  });
});
