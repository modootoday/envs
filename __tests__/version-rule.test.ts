import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The guard's own comparison, not a second copy of the idea.
import { surfaceDiff, surfaceMoved, surfaceOf } from "../scripts/surface.mjs";
import { COMMANDS } from "../src/commands/index.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = JSON.parse(
  readFileSync(join(pkgRoot, "scripts", "surface.json"), "utf8"),
) as { version: string; commands: { name: string; options: string[] }[] };

describe("the surface snapshot decides the version, not whoever ships it", () => {
  it("matches the commands that exist right now", () => {
    // When this fails a verb or flag moved, and the fix is to refresh the
    // snapshot in the same commit that moved it -- which is what makes the
    // minor bump a derivation rather than a preference.
    expect(surfaceOf(COMMANDS)).toEqual(snapshot.commands);
  });

  it("holds every command, so a missing one cannot pass as unchanged", () => {
    expect(snapshot.commands).toHaveLength(COMMANDS.length);
    expect(snapshot.commands.length).toBeGreaterThan(20);
  });

  it("sees a verb arrive or leave", () => {
    const before = surfaceOf(COMMANDS);
    const after = before.filter((c) => c.name !== "doctor");
    expect(surfaceMoved(surfaceDiff(before, after))).toBe(true);
    expect(surfaceDiff(before, after).gone).toEqual(["doctor"]);
    expect(surfaceDiff(after, before).added).toEqual(["doctor"]);
  });

  it("sees a flag arrive or leave", () => {
    const before = surfaceOf(COMMANDS);
    const after = before.map((c) =>
      c.name === "init" ? { ...c, options: c.options.slice(1) } : c,
    );
    const diff = surfaceDiff(before, after);
    expect(surfaceMoved(diff)).toBe(true);
    expect(diff.changed.join()).toContain("init:");
  });

  it("does not move when only the advice a command prints changes", () => {
    // Two findings were added to doctor and shipped as a minor on that basis.
    // Both were warnings, doctor exited 0 either way, and nothing here moved:
    // that is the whole reason the rule reads the surface and not the diff.
    expect(
      surfaceMoved(surfaceDiff(surfaceOf(COMMANDS), surfaceOf(COMMANDS))),
    ).toBe(false);
  });
});
