import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
let home: string;
let out: Capture;
let err: Capture;
let code: string;

async function cli(
  argv: readonly string[],
  env: Record<string, string>,
): Promise<number> {
  out = new Capture();
  err = new Capture();
  return await dispatch(argv, {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env,
    cwd: dir,
  });
}

// The child reports only whether a key arrived, never its value.
const CHILD = 'process.exit(process.env.A === "1" ? 0 : 3)';

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), "envs-run-unlock-"));
  dir = join(base, "project");
  home = join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");

  await cli(["init", "--recovery-codes", "1"], { HOME: home });
  // init writes its notices to stderr, codes included.
  const printed = /^\s+([0-9A-Z]{5}(?:-[0-9A-Z]{5}){4}-[0-9A-Z])\s*$/m.exec(
    err.text,
  );
  if (printed === null) throw new Error("init printed no recovery code");
  code = printed[1] as string;

  writeFileSync(join(dir, ".env"), "A=1\n");
  await cli(["load", ".env", "--recovery-code", code], { HOME: home });
});

afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("running a command against a catalog opened by recovery code", () => {
  it("takes the code from the environment", async () => {
    const status = await cli(
      ["run", "--no-global", "--", process.execPath, "-e", CHILD],
      { HOME: home, ENVS_RECOVERY_CODE: code, PATH: process.env["PATH"] ?? "" },
    );
    expect(status).toBe(0);
  });

  it("refuses with neither a code nor a key, and says which", async () => {
    // The control: without this the test above passes on a catalog that opened
    // some other way.
    const status = await cli(
      ["run", "--no-global", "--", process.execPath, "-e", CHILD],
      { HOME: home, PATH: process.env["PATH"] ?? "" },
    );
    expect(status).not.toBe(0);
    expect(err.text).toContain("ENVS_KEK");
  });

  it("says why a malformed code failed rather than running with nothing", async () => {
    // The alphabet is checked where the wrap is opened, not here, so this is a
    // failed run rather than a bad invocation. What matters is that the reason
    // reaches the caller instead of an empty environment reaching the child.
    const status = await cli(
      ["run", "--no-global", "--", process.execPath, "-e", CHILD],
      { HOME: home, ENVS_RECOVERY_CODE: "not a code", PATH: "" },
    );
    expect(status).not.toBe(0);
    expect(err.text).toMatch(/alphabet|recovery code/i);
  });
});
