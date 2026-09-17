import { describe, expect, it } from "vitest";

import {
  loadScopeResolver,
  ScopeProviderMissingError,
  SCOPE_PROVIDERS,
  type ScopeProvider,
} from "../src/scope/provider.js";

const provider = (over: Partial<ScopeProvider> = {}): ScopeProvider => ({
  name: "test",
  specifier: "test:scope",
  exportName: "resolveScope",
  ...over,
});

describe("the scope seam", () => {
  it("returns the first provider that exports the contract", async () => {
    const resolver = await loadScopeResolver(
      [provider({ specifier: "a" }), provider({ specifier: "b" })],
      async (specifier) =>
        specifier === "a"
          ? {}
          : { resolveScope: () => ({ aliases: ["x"], from: "b" }) },
    );
    expect(await resolver("/anywhere")).toEqual({ aliases: ["x"], from: "b" });
  });

  it("refuses when nothing loads, and names every attempt", async () => {
    // The refusal is the point: a fallback here would hand the caller a scope
    // nobody chose, and it would look like it worked.
    await expect(
      loadScopeResolver([provider({ specifier: "gone" })], async () => {
        throw new Error("Cannot find module");
      }),
    ).rejects.toThrow(ScopeProviderMissingError);
  });

  it("refuses a module that loads but lacks the export", async () => {
    // Half a provider is the worse case: the import succeeds, so a looser
    // check would take it and then call undefined.
    await expect(
      loadScopeResolver([provider()], async () => ({ somethingElse: () => {} })),
    ).rejects.toThrow(/no resolveScope export/);
  });

  it("names the attempts in the error, so the reader knows what was tried", async () => {
    const error = await loadScopeResolver(
      [provider({ specifier: "one" }), provider({ specifier: "two" })],
      async () => {
        throw new Error("boom");
      },
    ).catch((e: unknown) => e as ScopeProviderMissingError);
    expect(error.attempts.map(([s]) => s)).toEqual(["one", "two"]);
    expect(error.message).toContain("one");
    expect(error.message).toContain("two");
  });

  it("ships exactly one provider, and it is the package that reads declarations", () => {
    // A second entry is a decision someone makes; it should not arrive by
    // accident, and this package must never learn a declaration's shape.
    expect(SCOPE_PROVIDERS).toHaveLength(1);
    expect(SCOPE_PROVIDERS[0]?.specifier).toBe("@modootoday/envs-config/scope");
  });

  it("holds the specifier as data, not as a static import", () => {
    // A literal specifier makes a bundler treat the absent module as a hard
    // failure, which is what the sqlite path documents and avoids.
    expect(typeof SCOPE_PROVIDERS[0]?.specifier).toBe("string");
  });
});
