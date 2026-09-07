import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ArgumentError,
  many,
  one,
  parseArgs,
  type OptionSpec,
} from "../src/cli/command.js";
import { Ui, type Stream } from "../src/cli/ui.js";
import { dispatch } from "../src/commands/index.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

let dir: string;
let out: Capture;
let err: Capture;

function run(
  argv: readonly string[],
  env: Record<string, string> = {},
): number {
  out = new Capture();
  err = new Capture();
  return dispatch(argv, {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env,
    cwd: dir,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "envs-cli-"));
  // A project marker, so locate stops here. Without one it walked up, found
  // no root, and fell back to the machine's own global catalog -- these tests
  // were reading whatever the developer happened to have.
  writeFileSync(join(dir, "package.json"), "{}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("argument parsing is checked against the command's own options", () => {
  const specs: readonly OptionSpec[] = [
    { name: "flag", boolean: true, describe: "" },
    { name: "value", describe: "" },
    { name: "list", repeat: true, describe: "" },
  ];

  it("takes a value with a space or an equals sign", () => {
    expect(one(parseArgs(["--value", "x"], specs), "value")).toBe("x");
    expect(one(parseArgs(["--value=x"], specs), "value")).toBe("x");
  });

  it("collects a repeatable option in order", () => {
    expect(
      many(parseArgs(["--list", "a", "--list", "b"], specs), "list"),
    ).toEqual(["a", "b"]);
  });

  it("refuses an unknown option rather than ignoring a typo", () => {
    expect(() => parseArgs(["--valu", "x"], specs)).toThrow(ArgumentError);
    expect(() => parseArgs(["--valu", "x"], specs)).toThrow(/unknown option/);
  });

  it("refuses a repeat of an option that is not repeatable", () => {
    expect(() => parseArgs(["--value", "a", "--value", "b"], specs)).toThrow(
      /more than once/,
    );
  });

  it("refuses a value on a boolean flag", () => {
    expect(() => parseArgs(["--flag=1"], specs)).toThrow(
      /does not take a value/,
    );
  });

  it("refuses an option left without its value", () => {
    expect(() => parseArgs(["--value"], specs)).toThrow(/needs a value/);
  });

  it("stops interpreting after a bare double dash", () => {
    const parsed = parseArgs(["--flag", "--", "--value", "x"], specs);
    expect(parsed.positional).toEqual(["--value", "x"]);
    expect(parsed.flags.has("flag")).toBe(true);
  });
});

describe("dispatch", () => {
  it("prints help and exits 2 when called with nothing", () => {
    expect(run([])).toBe(2);
    expect(err.text).toContain("validate");
    expect(err.text).toContain("export");
  });

  it("exits 0 for explicit help", () => {
    expect(run(["--help"])).toBe(0);
  });

  it("shows one command's own options", () => {
    expect(run(["help", "export"])).toBe(0);
    expect(err.text).toContain("--recovery-code");
    expect(err.text).toContain("--include-global");
  });

  it("reports an unknown verb as unknown", () => {
    expect(run(["nonsense"])).toBe(2);
    expect(err.text).toContain('unknown command "nonsense"');
  });

  it("has nothing left to call planned", () => {
    expect(run(["doctor", "--help"])).toBe(0);
  });
  it("reports a bad flag against the command that rejected it", () => {
    expect(run(["export", "--recover-code", "x"])).toBe(2);
    expect(err.text).toContain("unknown option --recover-code");
    expect(err.text).toContain("envs export");
  });
});

describe("validate through the CLI", () => {
  it("reports a good file with its key count", () => {
    const file = join(dir, "good.env");
    writeFileSync(file, "A=1\n# c\nB=2\n");
    expect(run(["validate", file])).toBe(0);
    expect(err.text).toContain("2 keys");
  });

  it("reports line and finding, and never the value", () => {
    const file = join(dir, "bad.env");
    writeFileSync(file, "GOOD=s3cr3t\nname: envs\n");
    expect(run(["validate", file])).toBe(1);
    expect(err.text).toContain("line 2");
    expect(err.text).toContain("NOT_ENV_LINE");
    expect(err.text).not.toContain("s3cr3t");
  });

  it("exits 2 when given no path", () => {
    expect(run(["validate"])).toBe(2);
  });
});

describe("export refuses before it decrypts", () => {
  it("will not print values without --yes", () => {
    expect(run(["export"])).toBe(2);
    expect(err.text).toContain("--yes");
    expect(out.text).toBe("");
  });

  it("will not run without a key", () => {
    // A catalog first: without one this passed for the wrong reason, since
    // export refused for having nothing to export rather than no key.
    run(["init", "--recovery-codes", "1"]);
    expect(run(["export", "--yes"])).toBe(2);
    expect(err.text).toContain("no key given");
  });

  it("says to run init before it asks for a key", () => {
    expect(run(["export", "--yes"])).toBe(1);
    expect(err.text).toContain("envs init");
    expect(err.text).not.toContain("no key given");
  });

  it("rejects an unknown format before asking for a key", () => {
    expect(run(["export", "--yes", "--format", "xml"])).toBe(2);
    expect(err.text).toContain("unknown format");
  });

  it("warns when a recovery code is passed on the command line", () => {
    run(["init", "--recovery-codes", "1"]);
    run(["export", "--yes", "--recovery-code", "ABCDE-ABCDE"]);
    expect(err.text).toContain("visible to other processes");
  });
});

describe("output shape", () => {
  it("keeps data on stdout and everything else on stderr", () => {
    const file = join(dir, "good.env");
    writeFileSync(file, "A=1\n");
    run(["validate", file]);
    expect(out.text).toBe("");
    expect(err.text).not.toBe("");
  });

  it("emits no escape sequences when colour is off", () => {
    run(["--help"]);
    expect(err.text).not.toContain(String.fromCharCode(27));
  });

  it("emits them when colour is on", () => {
    const stderr = new Capture();
    const ui = new Ui({ stderr, color: true, env: {} });
    ui.success("done");
    expect(stderr.text).toContain(String.fromCharCode(27));
  });

  it("stays plain when NO_COLOR is set even on a TTY", () => {
    const stderr = new Capture();
    stderr.isTTY = true;
    const ui = new Ui({ stderr, env: { NO_COLOR: "1" } });
    expect(ui.colour).toBe(false);
  });
});
