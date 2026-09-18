import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const KEK = Buffer.from(new Uint8Array(32).fill(41)).toString("base64");

let base: string;
let dir: string;
let home: string;

function cli(argv: readonly string[], cwd: string): number | Promise<number> {
  return dispatch(argv, {
    ui: new Ui({
      stdout: new Capture(),
      stderr: new Capture(),
      color: false,
      env: {},
    }),
    env: { ENVS_KEK: KEK, HOME: home },
    cwd,
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "envs-empty-global-"));
  dir = join(base, "project");
  home = join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(join(home, "package.json"), "{}\n");

  await cli(["init"], dir);
  writeFileSync(join(dir, ".env"), "A=1\n");
  await cli(["load", ".env"], dir);

  // The machine-wide catalog exists and was never loaded, which is the state a
  // developer is left in by running init once in the home directory.
  await cli(["init"], home);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("a machine-wide catalog with no release", () => {
  it("contributes nothing instead of failing the read", () => {
    const result = config({
      cwd: dir,
      home,
      env: { ENVS_KEK: KEK, HOME: home },
      processEnv: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.parsed?.["A"]).toBe("1");
  });

  it("still fails when the project catalog is the empty one", () => {
    // The control, and the line the change must not cross: no release in the
    // catalog the caller asked about is an answer, not an empty layer.
    const result = config({
      cwd: home,
      home,
      env: { ENVS_KEK: KEK, HOME: home },
      processEnv: {},
    });
    expect(result.error?.message).toContain("no current release");
  });
});
