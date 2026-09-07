import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly bin?: Record<string, string>;
  readonly files?: readonly string[];
  readonly sideEffects?: readonly string[] | boolean;
  readonly exports?: Record<string, Record<string, string>>;
}

const manifest = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
) as Manifest;

/** Every path the manifest points a consumer at, with the field that names it. */
const declaredTargets = (): readonly (readonly [string, string])[] => {
  const out: [string, string][] = [];
  for (const field of ["main", "module", "types"] as const) {
    const value = manifest[field];
    if (value !== undefined) out.push([field, value]);
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
    for (const [condition, value] of Object.entries(conditions)) {
      out.push([`exports["${subpath}"].${condition}`, value]);
    }
  }
  for (const [name, value] of Object.entries(manifest.bin ?? {})) {
    out.push([`bin.${name}`, value]);
  }
  return out;
};

/**
 * A manifest can promise a subpath the build never emits, and nothing fails
 * until a consumer installs it. Measured: exports named ./dist/index.d.ts
 * while dts was off, and the documented ./config subpath did not exist at all.
 */
describe("what the manifest promises, the build emits", () => {
  it("checks every field a consumer resolves through", () => {
    // Named, not counted. it.each over an empty list registers no tests and
    // the file still passes, so a field disappearing would take its own check
    // away with it and nothing would say so.
    expect(declaredTargets().map(([field]) => field).sort()).toEqual([
      "bin.envs",
      'exports["."].import',
      'exports["."].require',
      'exports["."].types',
      'exports["./config"].import',
      'exports["./config"].require',
      'exports["./config"].types',
      "main",
      "module",
      "types",
    ]);
  });

  it.each(declaredTargets())("%s resolves to a built file", (_field, value) => {
    expect(existsSync(join(pkgRoot, value))).toBe(true);
  });

  it("carries a type declaration for every export condition set", () => {
    for (const conditions of Object.values(manifest.exports ?? {})) {
      expect(conditions["types"]).toBeDefined();
    }
  });

  it("resolves under both module systems, so require and node -r work", () => {
    for (const [subpath, conditions] of Object.entries(
      manifest.exports ?? {},
    )) {
      expect([subpath, conditions["import"] !== undefined]).toEqual([
        subpath,
        true,
      ]);
      expect([subpath, conditions["require"] !== undefined]).toEqual([
        subpath,
        true,
      ]);
    }
  });

  it("writes the bin path in the form npm keeps", () => {
    // npm rewrites a "./"-prefixed bin during publish and warns that it
    // corrected the manifest, so the published shape is not the reviewed one.
    for (const value of Object.values(manifest.bin ?? {})) {
      expect(value.startsWith("./")).toBe(false);
    }
  });

  it("packs the directory those targets live in", () => {
    expect(manifest.files ?? []).toContain("dist");
  });

  it("never claims to be free of side effects", () => {
    // The whole point of ./config is the effect, and the backup providers
    // register themselves through a bare import. Measured: listing only the
    // config entry made esbuild drop that registration from the bundle.
    const sideEffects = manifest.sideEffects;
    if (sideEffects === undefined) return;
    expect(sideEffects).not.toBe(false);
    if (Array.isArray(sideEffects)) {
      for (const condition of ["import", "require"] as const) {
        expect(sideEffects).toContain(
          manifest.exports?.["./config"]?.[condition],
        );
      }
    }
  });
});

describe("the published declarations stand on their own", () => {
  /**
   * Compiled, not grepped: an ambient name is only a defect where the checker
   * cannot resolve it, and a mention in prose is not one. Measured: encoding
   * was typed BufferEncoding, and a consumer with types:[] could not build.
   */
  it(
    "compiles with no ambient types loaded",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "envs-dts-"));
      const entries = ["index", "config"].map((name) =>
        join(pkgRoot, "dist", `${name}.d.ts`),
      );
      for (const entry of entries) expect(existsSync(entry)).toBe(true);

      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            types: [],
          },
          files: entries,
        }),
      );

      const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
      const result = spawnSync(process.execPath, [tsc, "-p", dir], {
        encoding: "utf8",
      });
      expect(result.stdout.trim()).toBe("");
      expect(result.status).toBe(0);
    },
    60_000,
  );
});

describe("the side-effect entry loads the environment on import", () => {
  const source = readFileSync(join(pkgRoot, "src", "config.ts"), "utf8");

  it("calls config at module scope rather than exporting a function", () => {
    expect(source).toMatch(/^\s*(?:export const \w+ =\s*)?config\(\)/m);
  });

  it("surfaces a failure instead of loading nothing", () => {
    expect(source).toMatch(/throw/);
  });
});
