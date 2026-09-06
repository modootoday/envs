import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
) as {
  name: string;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const SCANNED = new Set([".ts", ".mjs", ".js"]);
const SKIP = new Set(["node_modules", "dist", "dist-bundle", "coverage"]);

const sources = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SCANNED.has(extname(entry))) found.push(full);
    }
  };
  walk(pkgRoot);
  return found;
};

/** Every bare specifier a source file imports or requires. */
const specifiersIn = (text: string): string[] => {
  const out: string[] = [];
  const patterns = [
    /(?:^|[\s;{(])import\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1];
      if (spec !== undefined) out.push(spec);
    }
  }
  return out;
};

const manifestFiles = (): string[] => manifest.files ?? [];

const optionalPeers = new Set(
  Object.entries(manifest.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional === true)
    .map(([name]) => name),
);

/**
 * This package is published from its own repository, so a dependency that
 * only resolves inside the workspace would break every consumer without
 * breaking anything here. The checks are cheap; the failure is not.
 */
describe("the package stands on its own", () => {
  it("declares no workspace-protocol dependency", () => {
    const ranges = [
      ...Object.values(manifest.dependencies ?? {}),
      ...Object.values(manifest.devDependencies ?? {}),
      ...Object.values(manifest.peerDependencies ?? {}),
    ];
    expect(ranges.filter((range) => range.startsWith("workspace:"))).toEqual(
      [],
    );
  });

  it("declares no sibling package from this scope", () => {
    const named = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
    expect(named.filter((name) => name.startsWith("@modootoday/"))).toEqual([]);
  });

  it("ships with no runtime dependency at all", () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });

  it("imports only node builtins, relative paths, and optional peers", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      for (const spec of specifiersIn(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".") || spec.startsWith("/")) continue;
        if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
        if (optionalPeers.has(spec)) continue;
        // Config and test files may reach for the declared devDependencies.
        if (
          Object.keys(manifest.devDependencies ?? {}).some(
            (dep) => spec === dep || spec.startsWith(`${dep}/`),
          )
        ) {
          continue;
        }
        offenders.push(`${relative(pkgRoot, file)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never ships a sourcemap, which would publish the whole source tree", () => {
    expect(readFileSync(join(pkgRoot, "tsup.config.ts"), "utf8")).toMatch(
      /sourcemap:\s*false/,
    );
    // Defence in depth: if someone turns sourcemaps on for a debugging run,
    // the pack list still refuses to carry them.
    expect(manifestFiles()).toContain("!dist/**/*.map");
  });

  it("ignores what a checkout must not carry", () => {
    const ignored = readFileSync(join(pkgRoot, ".gitignore"), "utf8");
    for (const entry of ["node_modules/", "dist/", "*.tgz"]) {
      expect(ignored).toContain(entry);
    }
  });

  it("keeps the build configuration inline rather than inherited", () => {
    for (const config of [
      "tsconfig.json",
      "tsup.config.ts",
      "vitest.config.ts",
    ]) {
      const text = readFileSync(join(pkgRoot, config), "utf8");
      expect(text).not.toContain("@modootoday/");
      expect(text).not.toContain("extends");
    }
  });
});
