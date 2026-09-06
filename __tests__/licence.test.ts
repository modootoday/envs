import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string): string =>
  readFileSync(join(pkgRoot, name), "utf8");

const SPDX = "Elastic-2.0";
const LICENSOR = "modootoday";

/**
 * The published artefact contradicts itself if these disagree, and nobody
 * notices until someone reads the tarball. One test, three files.
 */
describe("the licence says the same thing in every place", () => {
  const manifest = JSON.parse(read("package.json")) as {
    license?: string;
    author?: string;
    files?: string[];
    private?: boolean;
  };

  it("names the SPDX identifier in the manifest", () => {
    expect(manifest.license).toBe(SPDX);
  });

  it("names the company as the licensor, not an individual", () => {
    expect(manifest.author).toBe(LICENSOR);
    expect(read("NOTICE")).toContain(`Licensor: ${LICENSOR}`);
    expect(read("NOTICE")).toContain(`Copyright (c) 2026 ${LICENSOR}`);
  });

  it("ships the licence and the notice", () => {
    expect(manifest.files).toContain("LICENSE");
    expect(manifest.files).toContain("NOTICE");
  });

  it("says the same thing in the README a reader sees first", () => {
    const readme = read("README.md");
    expect(readme).toContain("Elastic License 2.0");
    expect(readme).toContain(LICENSOR);
  });
});

describe("the licence text is the licence text", () => {
  const licence = read("LICENSE");

  it("is the Elastic License 2.0, unabridged", () => {
    expect(licence.startsWith("Elastic License 2.0")).toBe(true);
    for (const section of [
      "## Acceptance",
      "## Copyright License",
      "## Limitations",
      "## Patents",
      "## Notices",
      "## No Other Rights",
      "## Termination",
      "## No Liability",
      "## Definitions",
    ]) {
      expect(licence).toContain(section);
    }
  });

  it("still carries the two clauses this licence was chosen for", () => {
    // The patent grant and its retaliation, which BSD-3 and MIT do not have.
    expect(licence).toContain("under any patent claims the licensor can");
    // Wrapped across lines in the published text, so the whitespace is
    // normalised before looking rather than the phrase being guessed at.
    expect(licence.replace(/\s+/g, " ")).toContain(
      "as a hosted or managed service",
    );
  });

  it("has not been edited", () => {
    // The bytes fetched from the publisher. A licence that has been "tidied"
    // is a licence nobody can rely on.
    expect(createHash("sha256").update(licence).digest("hex")).toBe(
      "48255018b41fc0e965b1115af7e6779bc218bb8a6747d561da800d5022622aa2",
    );
  });
});

describe("the manifest asks for the publication it intends", () => {
  const manifest = JSON.parse(read("package.json")) as {
    private?: boolean;
    publishConfig?: { access?: string };
  };

  it("is not marked private", () => {
    // A scoped package that keeps this flag is skipped by publish with a
    // warning and exit 0, so the run looks like a success and nothing ships.
    expect(manifest.private).toBeUndefined();
  });

  it("asks for public access rather than relying on a remembered flag", () => {
    // Scoped packages default to restricted. Leaving this to the operator's
    // --access argument makes the first publish private to the org.
    expect(manifest.publishConfig?.access).toBe("public");
  });
});
