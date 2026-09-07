import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryRoot = join(pkgRoot, "registry");

interface Category {
  readonly label: string;
  readonly namespaces: readonly string[];
}

const doc = JSON.parse(
  readFileSync(join(registryRoot, "namespaces.json"), "utf8"),
) as { categories: readonly Category[] };

const templates = readdirSync(registryRoot, { recursive: true })
  .map(String)
  .filter((name) => name.endsWith(".json") && name.includes("/"))
  .map((name) => name.replace(/\.json$/, ""));

const withTemplates = [...new Set(templates.map((name) => name.split("/")[0]))];

/**
 * The list page is built from these groups, so a namespace in none of them is
 * not merely uncategorised: it is absent from the page while its own page and
 * its JSON stay live. That failure is silent everywhere else.
 */
describe("every template is reachable from the list page", () => {
  it("finds categories and templates to check", () => {
    expect(doc.categories.length).toBeGreaterThan(0);
    expect(templates.length).toBeGreaterThan(20);
  });

  it("places every namespace that has a template", () => {
    const placed = new Set(doc.categories.flatMap((c) => c.namespaces));
    expect(withTemplates.filter((name) => !placed.has(name)).sort()).toEqual(
      [],
    );
  });

  it("names no namespace twice", () => {
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const category of doc.categories) {
      for (const namespace of category.namespaces) {
        if (seen.has(namespace)) twice.push(namespace);
        seen.add(namespace);
      }
    }
    expect(twice.sort()).toEqual([]);
  });

  it("names no namespace that has no template", () => {
    // Otherwise the page grows an empty section nobody notices is empty.
    const held = new Set(withTemplates);
    const empty = doc.categories
      .flatMap((c) => c.namespaces)
      .filter((name) => !held.has(name));
    expect(empty.sort()).toEqual([]);
  });

  it("links every template from the built page", () => {
    // Read from the page rather than from the grouping that produced it: this
    // is the claim that matters, and it is the one a grouping bug breaks.
    const html = readFileSync(
      join(pkgRoot, "docs", "templates", "index.html"),
      "utf8",
    );
    const linked = [...html.matchAll(/href="\/templates\/([^"]+)\/"/g)]
      .map((match) => match[1] ?? "")
      .filter((name) => name.includes("/"));
    expect([...new Set(linked)].sort()).toEqual([...templates].sort());
  });
});
