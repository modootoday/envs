import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

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

let dir: string;
let home: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "envs-first-"));
  dir = join(base, "project");
  home = join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
});

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

/**
 * The first five minutes, before anything exists. Someone who has just
 * installed this types a command in a directory with no catalog, and what
 * they read there decides whether they get any further.
 */
describe("a command run before init says what to do about it", () => {
  const asks: readonly (readonly string[])[] = [
    ["get", "API_KEY"],
    ["set", "A", "1"],
    ["del", "A"],
    ["ls"],
    ["load", ".env"],
    ["doctor"],
    ["history"],
    ["rollback", "abcd1234"],
    ["export", "--yes"],
    ["rotate", "--key"],
    ["backup"],
    ["build", "--out", "x.js"],
    ["serve"],
    ["watch", "scan"],
    ["genexample"],
    ["migrate"],
  ];

  it.each(asks)("envs %s names init as the next step", async (...argv) => {
    const { said } = await run(argv);
    expect([argv.join(" "), /envs init/.test(said)]).toEqual([
      argv.join(" "),
      true,
    ]);
  });

  it("covers a command from most of the registry", () => {
    // Otherwise this list could quietly shrink to the ones that already pass.
    const named = new Set(asks.map(([verb]) => verb));
    expect(named.size).toBeGreaterThanOrEqual(15);
    for (const verb of named) {
      expect([verb, COMMANDS.some((c) => c.name === verb)]).toEqual([
        verb,
        true,
      ]);
    }
  });

  it("does not blame a missing key when the catalog is what is missing", async () => {
    // Measured: run() resolved the key before looking for the catalog, so a
    // new user was told to set ENVS_KEK when they had simply not run init.
    const { said } = await run(["run", "--", "node", "-e", ""]);
    expect(said).not.toMatch(/ENVS_KEK/);
    expect(said).toMatch(/no catalog/);
  });
});
