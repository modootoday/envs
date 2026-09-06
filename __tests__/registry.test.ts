import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkNamespace,
  checkObtain,
  namespaceOf,
  OBTAIN_DOMAINS,
  RESERVED_NAMESPACES,
} from "../src/template/registry.js";
import { parseTemplate } from "../src/template/schema.js";
import { looksLikeName, templateUrl } from "../src/template/fetch.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryRoot = join(pkgRoot, "registry");

const templateFiles = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".json")) found.push(full);
    }
  };
  walk(registryRoot);
  return found.sort();
};

/**
 * The gate the design asks for: every template merges only if it lints. A
 * convention would be checked by whoever remembers; this is checked by CI.
 */
describe("every template in the registry passes the same checks", () => {
  const files = templateFiles();

  it("finds templates to check", () => {
    // A detector that finds nothing must not pass.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [relative(registryRoot, file), file] as const))(
    "%s lints",
    (_label, file) => {
      const payload = readFileSync(file, "utf8");
      const name = (JSON.parse(payload) as { name?: unknown }).name;
      const template = parseTemplate(payload, {
        allowObtain: (url, at) => {
          checkObtain(typeof name === "string" ? name : "", url, at);
        },
      });
      // Ours, so the reserved namespaces must admit it.
      checkNamespace(template.name, "modootoday");
      expect(template.name).toBe(
        relative(registryRoot, file).replace(/\.json$/, ""),
      );
    },
  );

  it("serves every template under a name the client can resolve", () => {
    for (const file of files) {
      const name = relative(registryRoot, file).replace(/\.json$/, "");
      expect([name, looksLikeName(name)]).toEqual([name, true]);
    }
  });

  it("holds the namespace of every template it publishes", () => {
    for (const file of files) {
      const namespace = namespaceOf(relative(registryRoot, file));
      expect(RESERVED_NAMESPACES).toContain(namespace);
      expect(OBTAIN_DOMAINS[namespace]).toBeDefined();
    }
  });
});

describe("the published surfaces match the registry", () => {
  it("has no page or json out of date with registry/", () => {
    // The generator is the source of both surfaces; this is the guard that
    // they were regenerated after a template changed.
    const result = spawnSync(
      process.execPath,
      [join(pkgRoot, "scripts", "build-registry-pages.mjs"), "--check"],
      { encoding: "utf8" },
    );
    expect(result.stderr.trim()).toBe("");
    expect(result.status).toBe(0);
  });

  it("serves the reviewed bytes, not a re-serialisation", () => {
    // The digest a catalog records is of these bytes, so they must be the
    // same bytes the pull request reviewed.
    for (const file of templateFiles()) {
      const name = relative(registryRoot, file);
      expect([
        name,
        readFileSync(join(pkgRoot, "docs", "v1", "templates", name), "utf8"),
      ]).toEqual([name, readFileSync(file, "utf8")]);
    }
  });
});

describe("a name resolves to one fixed place", () => {
  it("builds the registry URL from the name", () => {
    expect(templateUrl("stripe/backend", "https://envs.build/v1/templates")).toBe(
      "https://envs.build/v1/templates/stripe/backend.json",
    );
  });

  it("refuses a name that would walk out of the registry", () => {
    for (const name of [
      "../etc/passwd",
      "stripe/../../x",
      "stripe/backend?x=1",
      "//evil.test/x",
    ]) {
      expect(() =>
        templateUrl(name, "https://envs.build/v1/templates"),
      ).toThrow();
    }
  });

  it("refuses a registry that is not https", () => {
    expect(() => templateUrl("stripe/backend", "http://evil.test")).toThrow(
      /https/,
    );
  });
});
