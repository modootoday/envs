import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Ui, type Stream } from "../src/cli/ui.js";
import { VERSION } from "../src/cli/version.js";
import { dispatch } from "../src/commands/index.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
) as { version: string; scripts: Record<string, string> };

const ask = (argv: readonly string[]) => {
  const out = new Capture();
  const err = new Capture();
  const code = dispatch(argv, {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env: {},
  });
  return { code, out: out.text, err: err.text };
};

describe("the tool can say which one it is", () => {
  it.each([["--version"], ["-v"], ["version"]])(
    "answers %s on stdout",
    (flag) => {
      const r = ask([flag]);
      expect(r.code).toBe(0);
      // stdout, because a script asking which version is asking for data.
      expect(r.out.trim()).toBe(VERSION);
      expect(r.err).toBe("");
    },
  );

  it("is real semver, not a placeholder", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(VERSION).not.toBe("0.0.0-source");
  });

  it("agrees with the manifest", () => {
    // Under vitest the define is applied by the same config the build uses, so
    // a bump that never reached the build fails here rather than at a user.
    expect(VERSION).toBe(manifest.version);
  });

  it("keeps the publish guard wired, since nothing else calls it", () => {
    // A guard nobody runs is a guard that is not there. prepack is the last
    // gate before bytes leave, so that is where it has to sit.
    expect(manifest.scripts["prepack"]).toContain("check-version");
  });
});
