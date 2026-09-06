import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Ui, type Stream } from "../src/cli/ui.js";
import { COMMANDS, dispatch } from "../src/commands/index.js";
import { config } from "../src/loader/config.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const KEK = Buffer.from(new Uint8Array(32).fill(41)).toString("base64");

let dir: string;
let home: string;
let out: Capture;
let err: Capture;

function run(
  argv: readonly string[],
  env: Record<string, string> = { ENVS_KEK: KEK },
): number {
  out = new Capture();
  err = new Capture();
  return dispatch(argv, {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env,
    cwd: dir,
  });
}

const load = (env: Record<string, string> = { ENVS_KEK: KEK }) =>
  config({ cwd: dir, home, env, processEnv: {} });

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "envs-parity-"));
  dir = join(base, "project");
  home = join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  run(["init", "--recovery-codes", "1"]);
  writeFileSync(join(dir, ".env"), "A=1\nB=two\n");
  run(["load", ".env"]);
});

afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("the surface a dotenvx user already knows", () => {
  const names = COMMANDS.map((command) => command.name);

  it("has the five core verbs", () => {
    for (const verb of ["run", "get", "set", "del", "ls"]) {
      expect(names).toContain(verb);
    }
  });

  it("has the hygiene verbs", () => {
    for (const verb of ["rotate", "genexample", "gitignore", "precommit"]) {
      expect(names).toContain(verb);
    }
  });
});

describe("set takes either spelling", () => {
  it("accepts KEY VALUE, as dotenvx and infisical do", () => {
    expect(run(["set", "C", "three"])).toBe(0);
    expect(load().parsed?.["C"]).toBe("three");
  });

  it("accepts KEY=VALUE, as doppler does", () => {
    expect(run(["set", "D=four"])).toBe(0);
    expect(load().parsed?.["D"]).toBe("four");
  });

  it("refuses three positionals rather than joining them", () => {
    expect(run(["set", "E", "five", "six"])).toBe(2);
  });
});

describe("get output formats", () => {
  it("prints the bare value by default", () => {
    expect(run(["get", "A"])).toBe(0);
    expect(out.text).toBe("1\n");
  });

  it("prints shell, eval and json shapes", () => {
    run(["get", "B", "--format", "shell"]);
    expect(out.text).toBe('B="two"\n');
    run(["get", "B", "--format", "eval"]);
    expect(out.text).toBe('export B="two"\n');
    run(["get", "B", "--format", "json"]);
    expect(JSON.parse(out.text)).toEqual({ B: "two" });
  });

  it("refuses a format it does not have", () => {
    expect(run(["get", "A", "--format", "yaml"])).toBe(2);
  });

  it("points at ls and export when no key is given", () => {
    expect(run(["get"])).toBe(2);
    expect(err.text).toContain("envs ls --keys");
  });
});

describe("del", () => {
  it("removes a key and leaves the rest", () => {
    expect(run(["del", "A"])).toBe(0);
    expect(load().parsed).toEqual({ B: "two" });
  });

  it("is undone by a rollback, because nothing was deleted", () => {
    run(["del", "A"]);
    run(["history"]);
    const ids = [...err.text.matchAll(/[* ] ([0-9a-f]{8})/g)].map((m) => m[1]!);
    run(["rollback", ids[1]!]);
    expect(load().parsed?.["A"]).toBe("1");
  });

  it("refuses a key that is not there rather than writing a no-op release", () => {
    expect(run(["del", "MISSING"])).toBe(1);
    expect(err.text).toContain("no value for MISSING");
  });
});

describe("ls", () => {
  it("lists sources without needing a key", () => {
    expect(run(["ls"], {})).toBe(0);
    expect(err.text).toContain("env");
    expect(err.text).toContain(join(dir, ".env"));
  });

  it("lists key names only with a key, and never a value", () => {
    expect(run(["ls", "--keys"])).toBe(0);
    expect(err.text).toContain("A B");
    expect(err.text).not.toContain("two");
  });

  it("says so when a key is needed for names", () => {
    expect(run(["ls", "--keys"], {})).toBe(2);
    expect(err.text).toContain("sealed");
  });
});

describe("run", () => {
  it("passes the values to the child and returns its exit code", () => {
    const script = join(dir, "child.mjs");
    writeFileSync(script, "process.exit(process.env.A === '1' ? 7 : 3);\n");
    expect(run(["run", "--", process.execPath, script])).toBe(7);
  });

  it("refuses before running when nothing resolved", () => {
    const bare = mkdtempSync(join(tmpdir(), "envs-bare-"));
    writeFileSync(join(bare, "package.json"), "{}\n");
    const code = dispatch(["run", "--", process.execPath, "-e", "0"], {
      ui: new Ui({
        stdout: new Capture(),
        stderr: (err = new Capture()),
        color: false,
        env: {},
      }),
      env: { ENVS_KEK: KEK },
      cwd: bare,
    });
    expect(code).toBe(1);
    rmSync(bare, { recursive: true, force: true });
  });

  it("reports a command that does not exist rather than exiting 0", () => {
    expect(run(["run", "--", "definitely-not-a-command-xyz"])).toBe(127);
  });
});

describe("rotate", () => {
  it("replaces the key, and the old one stops working", () => {
    expect(run(["rotate", "--key"])).toBe(0);
    const next = /ENVS_KEK=([A-Za-z0-9+/=]+)/.exec(err.text)?.[1];
    expect(next).toBeDefined();
    expect(next).not.toBe(KEK);

    expect(load({ ENVS_KEK: next! }).parsed).toEqual({ A: "1", B: "two" });
    expect(load({ ENVS_KEK: KEK }).error).toBeDefined();
  });

  it("replaces the recovery codes without touching a value", () => {
    expect(run(["rotate", "--recovery-codes", "2"])).toBe(0);
    const codes = [...err.text.matchAll(/^ {2}([0-9A-Z-]{20,})$/gm)].map(
      (m) => m[1]!,
    );
    expect(codes).toHaveLength(2);
    expect(run(["export", "--yes", "--recovery-code", codes[0]!])).toBe(0);
    expect(out.text).toContain('"A","1"');
  });

  it("refuses when told to rotate nothing", () => {
    expect(run(["rotate"])).toBe(2);
  });
});

describe("genexample", () => {
  it("writes key names with empty values", () => {
    expect(run(["genexample"])).toBe(0);
    const text = readFileSync(join(dir, ".env.example"), "utf8");
    expect(text).toBe("A=\nB=\n");
    expect(text).not.toContain("two");
  });

  it("writes envs.requires as names only", () => {
    expect(run(["genexample", "--requires"])).toBe(0);
    expect(readFileSync(join(dir, "envs.requires"), "utf8")).toBe("A\nB\n");
  });
});

describe("gitignore and precommit", () => {
  it("gitignore is idempotent", () => {
    expect(run(["gitignore"])).toBe(0);
    expect(err.text).toContain("already ignores");
  });

  it("precommit passes when nothing sensitive is tracked", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "package.json"], { cwd: dir });
    expect(run(["precommit"])).toBe(0);
    expect(err.text).toContain("nothing tracked");
  });

  it("precommit fails when a loaded plaintext file is tracked", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-f", ".env"], { cwd: dir });
    expect(run(["precommit"])).toBe(1);
    expect(err.text).toContain("holds plaintext values");
  });

  it("precommit fails when the catalog itself is tracked", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-f", ".envs/catalog.sqlite"], { cwd: dir });
    expect(run(["precommit"])).toBe(1);
    expect(err.text).toContain("must not be committed");
  });
});

describe("export gains the shell format", () => {
  it("prints export lines that a shell can eval", () => {
    expect(run(["export", "--yes", "--format", "shell"])).toBe(0);
    expect(out.text).toContain('export A="1"');
    expect(out.text).toContain('export B="two"');
  });
});

describe("the catalog file", () => {
  it("exists where locate says it does", () => {
    expect(existsSync(join(dir, ".envs", "catalog.sqlite"))).toBe(true);
  });
});
