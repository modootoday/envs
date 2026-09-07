import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exampleDrift, twins } from "../src/commands/doctor.js";
import { Ui, type Stream } from "../src/cli/ui.js";
import { dispatch } from "../src/commands/index.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const KEK = Buffer.from(new Uint8Array(32).fill(19)).toString("base64");

/** Entries shaped by hand, so the detector is not asked to agree with a loader. */
const entry = (key: string, value: string, alias = "env") =>
  ({
    key,
    value,
    alias,
    path: `/p/.${alias}`,
    layer: "project" as const,
  }) as Parameters<typeof twins>[0][number];

describe("one secret under two names", () => {
  const LONG = "sk_live_abcdefghijklmnop";

  it("names both keys and never the value", () => {
    const found = twins([entry("DB_URL", LONG), entry("DATABASE_URL", LONG)]);
    expect(found).toHaveLength(1);
    expect(found[0]!.what).toBe("DATABASE_URL");
    expect(found[0]!.detail).toContain("DB_URL");
    expect(found.map((f) => f.detail).join(" ")).not.toContain(LONG);
  });

  it("says nothing when two names hold different values", () => {
    expect(twins([entry("A", LONG), entry("B", `${LONG}x`)])).toEqual([]);
  });

  it("says nothing about one name in two files", () => {
    // That is the conflict finding's job. Reporting it here too would make the
    // same fact arrive twice under two names.
    expect(twins([entry("A", LONG, "env"), entry("A", LONG, "local")])).toEqual(
      [],
    );
  });

  it("leaves short values alone, which collide on their own", () => {
    // The threshold is inherited with its measurement: a three-character value
    // matched an unrelated TTL, and the shortest real twin was fourteen.
    expect(
      twins([entry("PORT", "3000"), entry("METRICS_PORT", "3000")]),
    ).toEqual([]);
    expect(
      twins([entry("A", "eleven_chrs"), entry("B", "eleven_chrs")]),
    ).toEqual([]);
    expect(
      twins([entry("A", "twelve_chars"), entry("B", "twelve_chars")]),
    ).toHaveLength(1);
  });

  it("reports a three-way twin once, not three times", () => {
    const found = twins([entry("A", LONG), entry("B", LONG), entry("C", LONG)]);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain("B");
    expect(found[0]!.detail).toContain("C");
  });
});

describe("the example file this tool wrote", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envs-drift-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("says nothing when there is no example", () => {
    expect(exampleDrift(dir, ["A", "B"])).toEqual([]);
  });

  it("says nothing when the example still matches", () => {
    writeFileSync(join(dir, ".env.example"), "A=\nB=\n");
    expect(exampleDrift(dir, ["A", "B"])).toEqual([]);
  });

  it("names a key the example does not list", () => {
    writeFileSync(join(dir, ".env.example"), "A=\n");
    const found = exampleDrift(dir, ["A", "STRIPE_SECRET_KEY"]);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain("STRIPE_SECRET_KEY");
    expect(found[0]!.detail).toContain("begins short");
  });

  it("names a key the example still lists after it went away", () => {
    writeFileSync(join(dir, ".env.example"), "A=\nGONE=\n");
    const found = exampleDrift(dir, ["A"]);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain("GONE");
  });

  it("reads envs.requires as names, not as assignments", () => {
    writeFileSync(join(dir, "envs.requires"), "# a comment\nA\nB\n");
    expect(exampleDrift(dir, ["A", "B"])).toEqual([]);
    expect(exampleDrift(dir, ["A"])[0]!.detail).toContain("B");
  });

  it("reads an example written with export and with comments", () => {
    writeFileSync(
      join(dir, ".env.example"),
      "# set these\nexport A=\n\nB=\n# C= was removed\n",
    );
    expect(exampleDrift(dir, ["A", "B"])).toEqual([]);
  });
});

describe("through the CLI, on a real catalog", () => {
  let dir: string;
  let home: string;

  const run = async (argv: readonly string[]) => {
    const err = new Capture();
    const code = await dispatch(argv, {
      ui: new Ui({ stdout: new Capture(), stderr: err, color: false, env: {} }),
      env: { ENVS_KEK: KEK, HOME: home },
      cwd: dir,
    });
    return { code, said: err.text };
  };

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), "envs-custody-"));
    dir = join(base, "project");
    home = join(base, "home");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");
    await run(["init", "--recovery-codes", "1"]);
  });
  afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

  it("reports both, and prints no value while doing it", async () => {
    const secret = "sk_live_abcdefghijklmnopqrs";
    writeFileSync(
      join(dir, ".env"),
      `DB_URL=${secret}\nDATABASE_URL=${secret}\n`,
    );
    await run(["load", ".env"]);
    await run(["genexample"]);
    writeFileSync(join(dir, ".env2"), "ADDED_LATER=x\n");
    await run(["load", ".env2", "--alias", "two"]);

    const { said } = await run(["doctor"]);
    expect(said).toContain("one secret in two names");
    expect(said).toContain(".env.example");
    expect(said).toContain("ADDED_LATER");
    expect(said).not.toContain(secret);
  });
});
