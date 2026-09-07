import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkNamespace,
  checkObtain,
  knownDomains,
  learnNamespaces,
  learnReserved,
  namespaceOf,
  parseNamespaceMap,
  parseReserved,
  reservedNamespaces,
} from "../src/template/registry.js";
import { parseTemplate } from "../src/template/schema.js";
import {
  MAX_INDEX_BYTES,
  fetchNamespaces,
  looksLikeName,
  templateUrl,
} from "../src/template/fetch.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryRoot = join(pkgRoot, "registry");

// The publish gate reads the map it is publishing alongside, and so does this:
// asking the compiled fallback instead is the drift moving the map out of the
// binary was meant to end.
const namespacesDoc = readFileSync(
  join(registryRoot, "namespaces.json"),
  "utf8",
);
learnNamespaces(parseNamespaceMap(namespacesDoc));
learnReserved(parseReserved(namespacesDoc));

const templateFiles = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      // namespaces.json sits at the root and is the allowlist, not a template.
      else if (entry.endsWith(".json") && dir !== registryRoot)
        found.push(full);
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
      expect([namespace, reservedNamespaces().includes(namespace)]).toEqual([
        namespace,
        true,
      ]);
      expect([namespace, knownDomains(namespace) !== undefined]).toEqual([
        namespace,
        true,
      ]);
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

/**
 * Outgrowing this bound is the one failure in the registry that looks like a
 * correct refusal: the fetch returns null, the caller keeps the compiled map,
 * and every namespace added since is reported as unreserved. So the size is
 * checked here rather than discovered from a stranger's bug report.
 */
describe("the published namespace map stays fetchable as it grows", () => {
  const published = readFileSync(
    join(pkgRoot, "docs", "v1", "namespaces.json"),
    "utf8",
  );

  it("is under the bound the client will accept", () => {
    expect([published.length < MAX_INDEX_BYTES, published.length]).toEqual([
      true,
      published.length,
    ]);
  });

  it("refuses a map that is over it, rather than half-reading one", async () => {
    // The rule fires: without this the bound is a line nobody has watched run.
    const oversized = JSON.stringify({
      namespaces: { stripe: ["dashboard.stripe.com"] },
      filler: "x".repeat(MAX_INDEX_BYTES),
    });
    const answer = await fetchNamespaces(
      "https://envs.build/v1/templates",
      (async () =>
        new Response(oversized, { status: 200 })) as unknown as typeof fetch,
    );
    expect(answer).toBe(null);
  });

  it("returns a map that is under it", async () => {
    const answer = await fetchNamespaces(
      "https://envs.build/v1/templates",
      (async () =>
        new Response(published, { status: 200 })) as unknown as typeof fetch,
    );
    expect(answer).toBe(published);
  });
});

describe("a name resolves to one fixed place", () => {
  it("builds the registry URL from the name", () => {
    expect(
      templateUrl("stripe/backend", "https://envs.build/v1/templates"),
    ).toBe("https://envs.build/v1/templates/stripe/backend.json");
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
