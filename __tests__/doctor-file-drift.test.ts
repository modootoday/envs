import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fileDrift } from "../src/commands/doctor.js";
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

const KEK = Buffer.from(new Uint8Array(32).fill(23)).toString("base64");

describe("a source's file against the current release", () => {
  let dir: string;
  const entry = (key: string, value: string, path: string) =>
    ({
      key,
      value,
      alias: "hints",
      path,
      layer: "project" as const,
    }) as Parameters<typeof fileDrift>[0][number];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envs-file-drift-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("says nothing when the file and the release agree", () => {
    const path = join(dir, "hints");
    writeFileSync(path, "# kept by hand\nA=one\nB=two\n");
    expect(fileDrift([entry("A", "one", path), entry("B", "two", path)])).toEqual(
      [],
    );
  });

  it("fails on a key whose values differ, naming the key and never a value", () => {
    const path = join(dir, "hints");
    writeFileSync(path, "A=north,south\n");
    const found = fileDrift([entry("A", "north", path)]);
    expect(found).toHaveLength(1);
    expect(found[0]!.level).toBe("error");
    expect(found[0]!.detail).toContain("A");
    expect(found[0]!.detail).not.toContain("south");
    expect(found[0]!.detail).not.toContain("north");
  });

  it("warns on a key held by only one side", () => {
    const path = join(dir, "hints");
    writeFileSync(path, "FILE_ONLY=x\n");
    const found = fileDrift([entry("CATALOG_ONLY", "y", path)]);
    expect(found.map((f) => f.level)).toEqual(["warn", "warn"]);
    expect(found.map((f) => f.detail).join(" ")).toContain("CATALOG_ONLY");
    expect(found.map((f) => f.detail).join(" ")).toContain("FILE_ONLY");
  });

  it("leaves a gone file and a value set by hand to their own findings", () => {
    expect(
      fileDrift([
        entry("A", "x", join(dir, "gone")),
        entry("B", "y", "envs:set"),
      ]),
    ).toEqual([]);
  });
});

describe("set and doctor, on a real catalog", () => {
  let dir: string;
  let home: string;

  const run = async (argv: readonly string[]) => {
    const err = new Capture();
    const code = await dispatch(argv, {
      ui: new Ui({ stdout: new Capture(), stderr: err, color: false, env: {} }),
      env: { ENVS_KEK: KEK, HOME: home },
      cwd: dir,
    });
    return { code, said: err.text };
  };

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), "envs-set-drift-"));
    dir = join(base, "project");
    home = join(base, "home");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, ".gitignore"), ".envs/\n");
    await run(["init", "--recovery-codes", "1"]);
    writeFileSync(join(dir, ".env"), "HINTS=north,south\n");
    await run(["load", ".env"]);
  });
  afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

  it("set --catalog-only warns that the file was left behind, and doctor then fails", async () => {
    const set = await run(["set", "HINTS=north", "--catalog-only"]);
    expect(set.code).toBe(0);
    expect(set.said).toContain("the file does not hold the new HINTS");

    const doctor = await run(["doctor"]);
    expect(doctor.code).toBe(1);
    expect(doctor.said).toContain("file and catalog hold different values for HINTS");
    expect(doctor.said).not.toContain("south");
  });

  it("set stays quiet when the file was edited to the same value first", async () => {
    writeFileSync(join(dir, ".env"), "HINTS=north\n");
    const set = await run(["set", "HINTS=north"]);
    expect(set.said).not.toContain("does not hold");
    expect((await run(["doctor"])).code).toBe(0);
  });
});
