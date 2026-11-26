import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Ui, type Stream } from "../src/cli/ui.js";
import { dispatch } from "../src/commands/index.js";
import { assignInDocument } from "../src/format/assign.js";
import { parseEnv, toRecord } from "../src/format/parse.js";
import { writeBack } from "../src/sourcefile/write-back.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const KEK = Buffer.from(new Uint8Array(32).fill(29)).toString("base64");
const SECRET = "s3cr3t-never-printed";

const read = (text: string) => toRecord(parseEnv(text)) ?? {};

describe("set writes the source's file", () => {
  let dir: string;
  let home: string;
  let file: string;

  const run = async (argv: readonly string[]) => {
    const out = new Capture();
    const err = new Capture();
    const code = await dispatch(argv, {
      ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
      env: { ENVS_KEK: KEK, HOME: home },
      cwd: dir,
    });
    return { code, said: out.text + err.text };
  };

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), "envs-set-write-"));
    dir = join(base, "project");
    home = join(base, "home");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, ".gitignore"), ".envs/\n");
    await run(["init", "--recovery-codes", "1"]);
    file = join(dir, ".env");
    writeFileSync(file, "# kept by hand\nA=one\nTOKEN=old-value\n# tail\n");
    chmodSync(file, 0o600);
    await run(["load", ".env"]);
  });
  afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

  it("replaces the line, keeps comments, order and mode, and doctor passes", async () => {
    const set = await run(["set", `TOKEN=${SECRET}`]);
    expect(set.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      `# kept by hand\nA=one\nTOKEN=${SECRET}\n# tail\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await run(["doctor"])).code).toBe(0);
    expect(set.said).not.toContain(SECRET);
  });

  it("appends a key the file does not have", async () => {
    await run(["set", "NEW_KEY=fresh"]);
    expect(read(readFileSync(file, "utf8")).NEW_KEY).toBe("fresh");
    expect(readFileSync(file, "utf8").startsWith("# kept by hand\n")).toBe(true);
  });

  it("leaves the file alone with --catalog-only", async () => {
    const set = await run(["set", `TOKEN=${SECRET}`, "--catalog-only"]);
    expect(read(readFileSync(file, "utf8")).TOKEN).toBe("old-value");
    expect(set.said).toContain("the file does not hold the new TOKEN");
  });

  it("refuses a value the readers would disagree on, and never prints it", async () => {
    const value = `it's $HOME and more`;
    const set = await run(["set", "TOKEN", value]);
    expect(set.code).toBe(0);
    expect(read(readFileSync(file, "utf8")).TOKEN).toBe("old-value");
    expect(set.said).toContain("quoting that the readers of an env file disagree on");
    expect(set.said).not.toContain("$HOME");
  });

  it("says it replaced the last of several assignments", async () => {
    writeFileSync(file, "TOKEN=first\nA=one\nTOKEN=old-value\n");
    const set = await run(["set", "TOKEN=next"]);
    expect(readFileSync(file, "utf8")).toBe("TOKEN=first\nA=one\nTOKEN=next\n");
    expect(set.said).toContain("the last of 2 assignments");
  });
});

describe("the quoting round trip", () => {
  it.each([
    ["spaces", "a b c"],
    ["a hash", "x#y"],
    ["an equals sign", "k=v=w"],
    ["double quotes", 'say "hi"'],
    ["a url", "postgres://u:p@h:5432/db?x=1"],
    ["a dollar sign, single quoted so no reader expands it", "$HOME/x"],
    ["nothing", ""],
  ])("writes a value with %s so it reads back byte for byte", (_, value) => {
    const done = assignInDocument("A=one\nTOKEN=old\n", "TOKEN", value);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(read(done.text)).toEqual({ A: "one", TOKEN: value });
  });

  it.each([
    ["a single quote", "it's"],
    ["a backslash", "C:\\path"],
    ["a newline", "line1\nline2"],
  ])("refuses a value with %s", (_, value) => {
    const done = assignInDocument("TOKEN=old\n", "TOKEN", value);
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.reason).not.toContain(value);
  });

  it("keeps an export prefix", () => {
    const done = assignInDocument("export TOKEN=old\n", "TOKEN", "new");
    expect(done.ok && done.text).toBe("export TOKEN=new\n");
  });
});

describe("the file as found", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envs-write-back-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a missing file rather than create one", () => {
    const done = writeBack(join(dir, "gone"), "TOKEN", SECRET);
    expect(done).toEqual({ ok: false, reason: `${join(dir, "gone")} does not exist` });
  });

  it("refuses a symbolic link and leaves its target alone", () => {
    const target = join(dir, "real");
    writeFileSync(target, "TOKEN=old\n");
    symlinkSync(target, join(dir, "link"));
    const done = writeBack(join(dir, "link"), "TOKEN", SECRET);
    expect(done.ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("TOKEN=old\n");
  });

  it("refuses a hard-linked file", () => {
    const target = join(dir, "real");
    writeFileSync(target, "TOKEN=old\n");
    linkSync(target, join(dir, "other"));
    expect(writeBack(target, "TOKEN", SECRET).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("TOKEN=old\n");
  });

  it("refuses when the file changed before the rename, and leaves no temp file", () => {
    const target = join(dir, "env");
    writeFileSync(target, "TOKEN=old\n");
    const done = writeBack(target, "TOKEN", SECRET, {
      beforeRename: () => writeFileSync(target, "TOKEN=racer\nB=2\n"),
    });
    expect(done.ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("TOKEN=racer\nB=2\n");
    expect(readdirSync(dir)).toEqual(["env"]);
  });

  it("never widens the mode, even for the temp file", () => {
    const target = join(dir, "env");
    writeFileSync(target, "TOKEN=old\n");
    chmodSync(target, 0o600);
    let tempMode = -1;
    writeBack(target, "TOKEN", "new", {
      beforeRename: () => {
        const temp = readdirSync(dir).find((name) => name !== "env");
        tempMode = statSync(join(dir, temp as string)).mode & 0o777;
      },
    });
    expect([tempMode, statSync(target).mode & 0o777]).toEqual([0o600, 0o600]);
    expect(readFileSync(target, "utf8")).toBe("TOKEN=new\n");
  });
});
