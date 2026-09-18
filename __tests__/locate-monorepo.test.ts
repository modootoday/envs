import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CATALOG_FILE,
  DIR_NAME,
  locateCatalogs,
} from "../src/loader/locate.js";

let base: string;
let repo: string;
let pkg: string;
let home: string;

const catalogIn = (dir: string): string => join(dir, DIR_NAME, CATALOG_FILE);

function writeCatalog(dir: string): void {
  mkdirSync(join(dir, DIR_NAME), { recursive: true });
  writeFileSync(catalogIn(dir), "");
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "envs-locate-"));
  repo = join(base, "repo");
  pkg = join(repo, "apps", "worker");
  home = join(base, "home");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(home, { recursive: true });
  // Both are project roots: the repository by its lockfile, the package by its
  // own manifest. That is the shape every workspace has.
  writeFileSync(join(repo, "bun.lock"), "");
  writeFileSync(join(pkg, "package.json"), "{}\n");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("which catalog a workspace package reads", () => {
  it("takes the repository's when the package has none", () => {
    writeCatalog(repo);
    const located = locateCatalogs({ cwd: pkg, home, env: { HOME: home } });
    expect(located.project).toBe(catalogIn(repo));
    expect(located.projectRoot).toBe(repo);
  });

  it("keeps the package's own when it has one", () => {
    writeCatalog(repo);
    writeCatalog(pkg);
    expect(
      locateCatalogs({ cwd: pkg, home, env: { HOME: home } }).project,
    ).toBe(catalogIn(pkg));
  });

  it("names the nearest root when no root above holds a catalog", () => {
    // The error a caller then prints says where to run init, and the nearest
    // root is the answer a reader expects there.
    expect(
      locateCatalogs({ cwd: pkg, home, env: { HOME: home } }).project,
    ).toBe(catalogIn(pkg));
  });

  it("lets an explicit path win over any search", () => {
    writeCatalog(repo);
    const elsewhere = join(base, "elsewhere.sqlite");
    const located = locateCatalogs({
      cwd: pkg,
      home,
      env: { HOME: home, ENVS_CATALOG_PATH: elsewhere },
    });
    expect(located.project).toBe(elsewhere);
    expect(located.source).toBe("explicit");
    expect(located.global).toBeUndefined();
  });

  it("still reports the machine-wide layer beside the project one", () => {
    writeCatalog(repo);
    expect(locateCatalogs({ cwd: pkg, home, env: { HOME: home } }).global).toBe(
      catalogIn(home),
    );
  });

  it("does not climb past a root that holds a catalog to one that also does", () => {
    // Nearest wins, so a package cannot be shadowed by something further up.
    writeCatalog(repo);
    const middle = join(repo, "apps");
    writeFileSync(join(middle, "package.json"), "{}\n");
    writeCatalog(middle);
    expect(
      locateCatalogs({ cwd: pkg, home, env: { HOME: home } }).project,
    ).toBe(catalogIn(middle));
  });
});
