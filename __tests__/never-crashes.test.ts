import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Ui, type Stream } from "../src/cli/ui.js";
import { COMMANDS, dispatch } from "../src/commands/index.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

let base: string;
let home: string;
let dir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "envs-crash-"));
  home = join(base, "home");
  dir = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  // A home the session check refuses. Measured: this is what a default umask
  // leaves on some machines, and every hosted command threw a stack trace.
  chmodSync(home, 0o775);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const run = async (argv: readonly string[]) => {
  const out = new Capture();
  const err = new Capture();
  const code = await dispatch(argv, {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env: { HOME: home },
    cwd: dir,
  });
  return { code, said: out.text + err.text };
};

describe("a refusal reaches the person as a sentence", () => {
  for (const argv of [
    ["whoami"],
    ["logout"],
    ["team", "ls"],
    ["team", "invite"],
  ]) {
    it(`envs ${argv.join(" ")} says what is wrong instead of throwing`, async () => {
      const { code, said } = await run(argv);
      expect(code).not.toBe(0);
      expect(said).toContain("not private");
      // The shape of a crash, not of an answer.
      expect(said).not.toContain("    at ");
    });
  }

  it("catches a failure nothing anticipated, from a real command", async () => {
    // The backstop itself, fired through a registered verb: a catalog path
    // that is not a database at all. Nothing below dispatch handles this, so a
    // green here proves the last-resort branch runs rather than that it exists.
    // A directory where a file is expected: it exists, so the command's own
    // check passes, and the read then throws where nothing catches it.
    const out = new Capture();
    const err = new Capture();
    const code = await dispatch(["template", "lint", dir], {
      ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
      env: { HOME: home },
      cwd: dir,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("could not finish");
    expect(err.text).not.toContain("    at ");
  });

  it("every command answers --help without throwing", async () => {
    for (const command of COMMANDS) {
      const { code, said } = await run([command.name, "--help"]);
      expect([command.name, code]).toEqual([command.name, 0]);
      expect(said).not.toContain("    at ");
    }
  });
});
