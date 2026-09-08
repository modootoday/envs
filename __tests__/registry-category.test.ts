import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryRoot = join(pkgRoot, "registry");

interface Category {
  readonly label: string;
  readonly templates: readonly string[];
}

const doc = JSON.parse(
  readFileSync(join(registryRoot, "namespaces.json"), "utf8"),
) as { categories: readonly Category[] };

const templates = readdirSync(registryRoot, { recursive: true })
  .map(String)
  .filter((name) => name.endsWith(".json") && name.includes("/"))
  .map((name) => name.replace(/\.json$/, ""));

/**
 * The list page is built from these groups, so a template in none of them is
 * not merely uncategorised: it is absent from the page while its own page and
 * its JSON stay live. That failure is silent everywhere else.
 *
 * Keyed on the template rather than its namespace. Namespace keying grouped
 * google/gemini with google/maps and twilio/api with twilio/video, so a model
 * API was filed under maps and an SMS API under video.
 */
describe("every template is reachable from the list page", () => {
  it("finds categories and templates to check", () => {
    expect(doc.categories.length).toBeGreaterThan(0);
    expect(templates.length).toBeGreaterThan(20);
  });

  it("places every template", () => {
    const placed = new Set(doc.categories.flatMap((c) => c.templates));
    expect(templates.filter((name) => !placed.has(name)).sort()).toEqual([]);
  });

  it("names no template twice", () => {
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const category of doc.categories) {
      for (const name of category.templates) {
        if (seen.has(name)) twice.push(name);
        seen.add(name);
      }
    }
    expect(twice.sort()).toEqual([]);
  });

  it("names no template that does not exist", () => {
    // Otherwise the page grows an empty section nobody notices is empty.
    const held = new Set(templates);
    const absent = doc.categories
      .flatMap((c) => c.templates)
      .filter((name) => !held.has(name));
    expect(absent.sort()).toEqual([]);
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
