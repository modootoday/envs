import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureCatalogDir } from "../src/catalog/dir.js";
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

const modeOf = (path: string): string =>
  (statSync(path).mode & 0o777).toString(8);

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "envs-dir-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("the catalog directory is narrowed, not just the file", () => {
  it("creates a private directory where none existed", () => {
    const dir = join(base, "fresh", ".envs");
    expect(ensureCatalogDir(dir)).toBe("created");
    expect(modeOf(dir)).toBe("700");
  });

  // The case that was missing. mkdirSync applies its mode only when it
  // creates, so a directory that predates the call keeps the umask's answer,
  // and the creation path -- the one nobody suspected -- passes either way.
  it("narrows one that already exists group-writable", () => {
    const dir = join(base, "loose", ".envs");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o775);
    expect(modeOf(dir)).toBe("775");

    expect(ensureCatalogDir(dir)).toBe("narrowed");
    expect(modeOf(dir)).toBe("700");
  });

  it("narrows one that is world-writable too", () => {
    const dir = join(base, "open", ".envs");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    expect(ensureCatalogDir(dir)).toBe("narrowed");
    expect(modeOf(dir)).toBe("700");
  });

  it("leaves an already private one alone and says so", () => {
    const dir = join(base, "tight", ".envs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect(ensureCatalogDir(dir)).toBe("ok");
    expect(modeOf(dir)).toBe("700");
  });
});

describe("envs init through the CLI", () => {
  const run = async (dir: string, home: string) => {
    const err = new Capture();
    const code = await dispatch(["init", "--recovery-codes", "1"], {
      ui: new Ui({ stdout: new Capture(), stderr: err, color: false, env: {} }),
      env: { HOME: home },
      cwd: dir,
    });
    return { code, said: err.text };
  };

  it("leaves 700 behind under a loose umask, and 600 on the catalog", async () => {
    // Measured 20260907 on this host: a default umask of 002 left .envs at 775
    // while the catalog file was correctly 600, so the file was private inside
    // a directory anyone in the group could empty.
    const dir = join(base, "p1");
    const home = join(base, "h1");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");
    const previous = process.umask(0o002);
    try {
      expect((await run(dir, home)).code).toBe(0);
    } finally {
      process.umask(previous);
    }
    expect(modeOf(join(dir, ".envs"))).toBe("700");
    expect(modeOf(join(dir, ".envs", "catalog.sqlite"))).toBe("600");
  });

  it("tells the person when it changed a directory they already had", async () => {
    const dir = join(base, "p2");
    const home = join(base, "h2");
    mkdirSync(join(dir, ".envs"), { recursive: true });
    chmodSync(join(dir, ".envs"), 0o775);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");

    const { code, said } = await run(dir, home);
    expect(code).toBe(0);
    expect(said).toContain("narrowed the catalog directory");
    expect(modeOf(join(dir, ".envs"))).toBe("700");
  });
});
