/**
 * Where the catalogs are. The rule is that a catalog's scope matches what it
 * holds: a project's values live with the project, a person's live in the home
 * directory, and the home one only stands in when there is no project.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DIR_NAME = ".envs";
export const CATALOG_FILE = "catalog.sqlite";

/** Any one of these marks a project root. No new marker is invented. */
const ROOT_MARKERS = [
  "bun.lock",
  "bun.lockb",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  ".git",
  "package.json",
];

export function findProjectRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function globalDir(home = homedir()): string {
  return join(home, DIR_NAME);
}

export interface LocateOptions {
  readonly cwd?: string;
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface Located {
  /** The catalog this project reads and writes. Always present. */
  readonly project: string;
  /**
   * The machine-wide layer, when a project catalog is distinct from it. Absent
   * when there is no project root, because then the home catalog is the project
   * one and there is no second layer.
   */
  readonly global?: string;
  readonly projectRoot?: string;
  readonly source: "explicit" | "project" | "global";
}

/**
 * ENVS_CATALOG_PATH names one catalog and suppresses the layering: a caller
 * that says exactly which file to read should not silently get a second.
 */
export function locateCatalogs(options: LocateOptions = {}): Located {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  // The caller's env decides, as it does everywhere else here. Reading the
  // process's real home instead meant a command given an env still resolved
  // the machine's global catalog, which a test cannot isolate from.
  const home = options.home ?? env["HOME"] ?? homedir();

  const explicit = env["ENVS_CATALOG_PATH"];
  if (explicit !== undefined && explicit !== "") {
    return { project: resolve(explicit), source: "explicit" };
  }

  const globalPath = join(globalDir(home), CATALOG_FILE);
  const root = findProjectRoot(cwd);
  if (root === undefined) {
    return { project: globalPath, source: "global" };
  }
  return {
    project: join(root, DIR_NAME, CATALOG_FILE),
    global: globalPath,
    projectRoot: root,
    source: "project",
  };
}

/**
 * The cache follows the binary rather than the catalog: node_modules when
 * installed, the home directory under npx or a global install. It is derived,
 * so the two never disagree in a way that matters.
 */
export function cacheDir(options: LocateOptions = {}): string {
  const argv1 = process.argv[1] ?? "";
  const ephemeral = /[\\/]_npx[\\/]/.test(argv1);
  const root = findProjectRoot(options.cwd ?? process.cwd());
  if (!ephemeral && root !== undefined) {
    return join(root, "node_modules", ".cache", "envs");
  }
  return join(globalDir(options.home ?? homedir()), "cache");
}
