import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkObtain,
  knownDomains,
  learnNamespaces,
  parseNamespaceMap,
} from "../src/template/registry.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const shipped = readFileSync(
  join(pkgRoot, "registry", "namespaces.json"),
  "utf8",
);

// The learned map is process state, so each case starts from the compiled one.
afterEach(() => learnNamespaces({}));

describe("a provider arriving must not need a new CLI", () => {
  it("accepts a namespace the build has never heard of", () => {
    // The whole point: this name is in no compiled list, and the registry
    // saying so is enough. Without this every template published after a
    // release is unusable by everyone who installed before it.
    expect(knownDomains("linear")).toBeUndefined();
    expect(() =>
      checkObtain("linear/api", "https://linear.app/settings/api", "at"),
    ).toThrow(/no obtain allowlist/);

    learnNamespaces(
      parseNamespaceMap('{"namespaces":{"linear":["linear.app"]}}'),
    );
    expect(() =>
      checkObtain("linear/api", "https://linear.app/settings/api", "at"),
    ).not.toThrow();
  });

  it("still refuses a host the registry did not name", () => {
    learnNamespaces(
      parseNamespaceMap('{"namespaces":{"linear":["linear.app"]}}'),
    );
    expect(() =>
      checkObtain("linear/api", "https://linear.evil.test/keys", "at"),
    ).toThrow(/not one of/);
  });

  it("refuses an unknown namespace when nothing knows it", () => {
    // A registry that cannot answer leaves the compiled list standing, so the
    // failure is a stricter check rather than an open one.
    expect(() =>
      checkObtain("nobody/api", "https://nobody.example/keys", "at"),
    ).toThrow(/no obtain allowlist/);
  });

  it("keeps the compiled entries when the registry adds others", () => {
    learnNamespaces(
      parseNamespaceMap('{"namespaces":{"linear":["linear.app"]}}'),
    );
    expect(() =>
      checkObtain(
        "stripe/backend",
        "https://dashboard.stripe.com/apikeys",
        "at",
      ),
    ).not.toThrow();
  });
});

describe("the map is read strictly, because it decides where a reader is sent", () => {
  it("refuses a host that is really a URL", () => {
    expect(() =>
      parseNamespaceMap(
        '{"namespaces":{"x":["https://evil.test/#stripe.com"]}}',
      ),
    ).toThrow(/not a host/);
    expect(() =>
      parseNamespaceMap('{"namespaces":{"x":["stripe.com/path"]}}'),
    ).toThrow(/not a host/);
  });

  it("refuses an empty host list, which would read as allow-nothing or allow-all", () => {
    expect(() => parseNamespaceMap('{"namespaces":{"x":[]}}')).toThrow(
      /lists no hosts/,
    );
  });

  it("refuses a namespace name that is not one", () => {
    expect(() =>
      parseNamespaceMap('{"namespaces":{"Stripe":["stripe.com"]}}'),
    ).toThrow(/not a namespace name/);
  });

  it("refuses a document with no namespaces object", () => {
    expect(() => parseNamespaceMap("{}")).toThrow(/no namespaces object/);
  });
});

describe("the shipped map and the published map are one file", () => {
  it("parses, and covers every namespace the build compiles in", () => {
    const map = parseNamespaceMap(shipped);
    // A template published under a compiled namespace must not stop working
    // because the registry copy forgot it.
    for (const name of ["stripe", "openai", "github", "supabase", "slack"]) {
      expect([name, name in map]).toEqual([name, true]);
    }
  });
});
