import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveAlias, normaliseAlias } from "../src/catalog/alias.js";
import { Ui, type Stream } from "../src/cli/ui.js";
import { dispatch } from "../src/commands/index.js";
import { config } from "../src/loader/config.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const KEK = Buffer.from(new Uint8Array(32).fill(21)).toString("base64");

let dir: string;
let home: string;
let out: Capture;
let err: Capture;

function run(
  argv: readonly string[],
  env: Record<string, string> = { ENVS_KEK: KEK },
): number {
  out = new Capture();
  err = new Capture();
  return dispatch(argv, {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env: { HOME: home, ...env },
    cwd: dir,
  });
}

const load = (): ReturnType<typeof config> =>
  config({ cwd: dir, home, env: { ENVS_KEK: KEK }, processEnv: {} });

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "envs-write-"));
  dir = join(base, "project");
  home = join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
});

afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("init", () => {
  it("creates a catalog, prints the key and the codes, and stores neither", () => {
    expect(run(["init"], {})).toBe(0);
    expect(existsSync(join(dir, ".envs", "catalog.sqlite"))).toBe(true);
    expect(err.text).toContain("ENVS_KEK=");
    expect(err.text).toContain("Recovery codes");

    const codes = [...err.text.matchAll(/^ {2}([0-9A-Z-]{20,})$/gm)].map(
      (m) => m[1]!,
    );
    expect(codes).toHaveLength(5);
    const bytes = readFileSync(join(dir, ".envs", "catalog.sqlite")).toString(
      "latin1",
    );
    for (const code of codes) {
      expect(bytes).not.toContain(code.replace(/-/g, ""));
    }
  });

  it("uses an ENVS_KEK already set instead of minting one", () => {
    expect(run(["init"])).toBe(0);
    expect(err.text).not.toContain("ENVS_KEK=");
    expect(err.text).toContain("already in your environment");
  });

  it("refuses to re-init, because that would orphan every value", () => {
    run(["init"]);
    expect(run(["init"])).toBe(1);
    expect(err.text).toContain("already exists");
    expect(err.text).toContain("nothing was changed");
  });

  it("adds .envs/ to .gitignore, and says so only when it did", () => {
    run(["init"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".envs/");
    rmSync(join(dir, ".envs"), { recursive: true });
    run(["init"]);
    expect(err.text).toContain("already ignores");
  });

  it("warns when no recovery codes were asked for", () => {
    expect(run(["init", "--recovery-codes", "0"])).toBe(0);
    expect(err.text).toContain("no recovery codes");
  });

  it("refuses a count that is not a small whole number", () => {
    expect(run(["init", "--recovery-codes", "many"])).toBe(2);
    expect(run(["init", "--recovery-codes", "99"])).toBe(2);
  });
});

describe("load", () => {
  beforeEach(() => {
    run(["init", "--recovery-codes", "1"]);
  });

  it("puts a file's values where config() finds them", () => {
    writeFileSync(join(dir, ".env"), "A=1\nB=two\n");
    expect(run(["load", ".env"])).toBe(0);
    expect(load().parsed).toEqual({ A: "1", B: "two" });
  });

  it("names the source after the file, without the leading dot", () => {
    writeFileSync(join(dir, ".env"), "A=1\n");
    run(["load", ".env"]);
    expect(load().provenance?.[0]?.from).toBe("env");
  });

  it("refuses a file that is not env format and writes nothing", () => {
    writeFileSync(join(dir, "conf.yaml"), "name: envs\nversion: 1\n");
    expect(run(["load", "conf.yaml"])).toBe(1);
    expect(err.text).toContain("nothing loaded");
    expect(load().error?.message).toMatch(/no current release/);
  });

  it("refuses the whole batch when one of several files is bad", () => {
    writeFileSync(join(dir, "good.env"), "A=1\n");
    writeFileSync(join(dir, "bad.env"), 'B="unterminated\n');
    expect(run(["load", "good.env", "bad.env"])).toBe(1);
    expect(load().error?.message).toMatch(/no current release/);
  });

  it("carries other sources forward, so loading one does not empty the rest", () => {
    writeFileSync(join(dir, "a.env"), "A=1\n");
    writeFileSync(join(dir, "b.env"), "B=2\n");
    run(["load", "a.env"]);
    run(["load", "b.env"]);
    expect(load().parsed).toEqual({ A: "1", B: "2" });
    expect(err.text).toContain("carried 1 values");
  });

  it("drops the others when told to replace", () => {
    writeFileSync(join(dir, "a.env"), "A=1\n");
    writeFileSync(join(dir, "b.env"), "B=2\n");
    run(["load", "a.env"]);
    run(["load", "b.env", "--replace"]);
    expect(load().parsed).toEqual({ B: "2" });
  });

  it("keeps a source's alias when the same path is loaded again", () => {
    writeFileSync(join(dir, ".env"), "A=1\n");
    run(["load", ".env"]);
    writeFileSync(join(dir, ".env"), "A=2\n");
    run(["load", ".env"]);
    expect(load().parsed).toEqual({ A: "2" });
    expect(load().provenance?.[0]?.from).toBe("env");
  });

  it("refuses --alias with more than one path", () => {
    writeFileSync(join(dir, "a.env"), "A=1\n");
    writeFileSync(join(dir, "b.env"), "B=2\n");
    expect(run(["load", "a.env", "b.env", "--alias", "x"])).toBe(2);
  });
});

describe("set", () => {
  beforeEach(() => {
    run(["init", "--recovery-codes", "1"]);
    writeFileSync(join(dir, ".env"), "A=1\n");
    run(["load", ".env"]);
  });

  it("replaces a value and says which key, never the value", () => {
    expect(run(["set", "A=changed"])).toBe(0);
    expect(err.text).toContain("replaced A");
    expect(err.text).not.toContain("changed");
    expect(load().parsed).toEqual({ A: "changed" });
  });

  it("adds a key that was not there", () => {
    expect(run(["set", "NEW=x"])).toBe(0);
    expect(err.text).toContain("added NEW");
    expect(load().parsed).toEqual({ A: "1", NEW: "x" });
  });

  it("parses the assignment by the same rule a file uses", () => {
    run(["set", 'Q="has space"']);
    expect(load().parsed?.["Q"]).toBe("has space");
  });

  it("refuses something that is not one assignment", () => {
    expect(run(["set", "NOT_AN_ASSIGNMENT"])).toBe(2);
  });

  it("refuses the two spellings mixed, rather than reading a key called A=1", () => {
    expect(run(["set", "A=1", "B=2"])).toBe(2);
    expect(err.text).toContain("mixes both spellings");
  });

  it("will not guess a source when there is more than one", () => {
    writeFileSync(join(dir, "b.env"), "B=2\n");
    run(["load", "b.env"]);
    expect(run(["set", "C=3"])).toBe(2);
    expect(err.text).toContain("--source");
    expect(run(["set", "C=3", "--source", "b-env"])).toBe(0);
  });

  it("names the sources it knows when given one it does not", () => {
    expect(run(["set", "C=3", "--source", "nope"])).toBe(1);
    expect(err.text).toContain('no source "nope"');
  });

  it("leaves the earlier release intact, so a rollback has something to move to", () => {
    run(["set", "A=second"]);
    run(["set", "A=third"]);
    expect(load().parsed).toEqual({ A: "third" });
  });
});

describe("alias derivation", () => {
  it("makes a usable identifier out of a dotted filename", () => {
    expect(normaliseAlias(".env")).toBe("env");
    expect(normaliseAlias(".env.example")).toBe("env-example");
    expect(normaliseAlias(".env.d")).toBe("env-d");
  });

  it("refuses a name that normalises to nothing", () => {
    expect(() => normaliseAlias("...")).toThrow(/normalises to nothing/);
  });

  it("qualifies by path before falling back to a counter", () => {
    const taken = new Set(["env-example"]);
    expect(deriveAlias("/w/checkout/.env.example", { taken })).toBe(
      "checkout-env-example",
    );
  });

  it("reaches further up when one segment is not enough", () => {
    const taken = new Set(["env-example", "app-env-example"]);
    expect(deriveAlias("/w/checkout/app/.env.example", { taken })).toBe(
      "checkout-app-env-example",
    );
  });

  it("uses a counter only when the path cannot distinguish it", () => {
    const taken = new Set(["env", "a-env", "b-a-env"]);
    expect(deriveAlias("/b/a/.env", { taken, maxSegments: 2 })).toBe("env_1");
  });
});
