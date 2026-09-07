import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The publish guard's own detector, so the test exercises what runs at release
// rather than a second copy of the same idea.
import { versionClaims } from "../scripts/check-version.mjs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("a version written into the public surface is caught", () => {
  it("reads a version pinned to this package", () => {
    expect(versionClaims("npx @modootoday/envs@0.1.1 init")).toEqual(["0.1.1"]);
    expect(versionClaims("install envs@2.3.4 first")).toEqual(["2.3.4"]);
    expect(versionClaims("running envs v9.9.9 here")).toEqual(["9.9.9"]);
  });

  it("leaves a measured third-party version alone", () => {
    // docs/format quotes dotenv 17.4.2 as the version a measurement was taken
    // against. A detector that flagged it would make the guard unusable, and
    // someone would switch it off rather than fix the page.
    expect(versionClaims("Measured against dotenv 17.4.2:")).toEqual([]);
    expect(versionClaims("node 20.11.0 or later")).toEqual([]);
  });

  it("finds nothing in the surface as it stands", () => {
    // If this ever fails, a page has started claiming a version and the guard
    // is doing its job; the fix is the page, not this test.
    const files: string[] = [join(pkgRoot, "README.md")];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(html|md|json|txt|xml)$/.test(entry.name)) files.push(path);
      }
    };
    walk(join(pkgRoot, "docs"));
    expect(files.length).toBeGreaterThan(10);

    const claims = files.flatMap((file) =>
      versionClaims(readFileSync(file, "utf8")).map(
        (v) => `${file.slice(pkgRoot.length + 1)}: ${v}`,
      ),
    );
    expect(claims).toEqual([]);
  });
});
