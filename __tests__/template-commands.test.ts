import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Ui, type Stream } from "../src/cli/ui.js";
import { dispatch } from "../src/commands/index.js";
import { openDatabaseSync } from "../src/sqlite/open.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

let dir: string;
let out: Capture;
let err: Capture;

async function run(argv: readonly string[]): Promise<number> {
  out = new Capture();
  err = new Capture();
  return dispatch(argv, {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env: { ENVS_KEK: KEK },
    cwd: dir,
  });
}

const said = (): string => out.text + err.text;

const TEMPLATE = {
  name: "stripe/backend",
  version: 1,
  title: "Stripe — server-side integration",
  keys: {
    STRIPE_SECRET_KEY: {
      required: true,
      sensitivity: "secret",
      pattern: "^sk_(test|live)_[A-Za-z0-9]{24,}$",
      obtain: "https://dashboard.stripe.com/apikeys",
      rotateDays: 90,
    },
    STRIPE_PUBLISHABLE_KEY: {
      required: false,
      sensitivity: "config",
      pattern: "^pk_(test|live)_[A-Za-z0-9]{24,}$",
    },
  },
};

const templateFile = (override: Record<string, unknown> = {}): string => {
  const path = join(dir, "template.json");
  writeFileSync(path, JSON.stringify({ ...TEMPLATE, ...override }, null, 2));
  return path;
};

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), "envs-tpl-"));
  dir = join(base, "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  await run(["init", "--recovery-codes", "1"]);
});

afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("envs add declares keys without setting a value", () => {
  it("declares the template's keys and says nothing was set", async () => {
    expect(await run(["add", templateFile()])).toBe(0);
    expect(said()).toContain("STRIPE_SECRET_KEY");
    expect(said()).toContain("no values were set");
  });

  it("leaves a key that already has a value alone", async () => {
    // A template must never reclassify or overwrite what someone already set.
    writeFileSync(join(dir, ".env"), "STRIPE_SECRET_KEY=sk_live_keepthisvalue\n");
    await run(["load", ".env"]);
    expect(await run(["add", templateFile()])).toBe(0);
    expect(said()).toContain("already present");

    await run(["get", "STRIPE_SECRET_KEY"]);
    expect(out.text).toContain("sk_live_keepthisvalue");
  });

  it("does not put an empty value where run would inject one", async () => {
    // An empty value is worse than an absent key: the program sees a set
    // variable and gets an empty string instead of failing.
    writeFileSync(join(dir, ".env"), "OTHER=1\n");
    await run(["load", ".env"]);
    await run(["add", templateFile()]);
    const code = await run([
      "run",
      "--",
      "node",
      "-e",
      "process.exit('STRIPE_SECRET_KEY' in process.env ? 1 : 0)",
    ]);
    expect(code).toBe(0);
  });

  it("refuses a template with a field the schema does not name", async () => {
    const path = join(dir, "bad.json");
    writeFileSync(
      path,
      JSON.stringify({ ...TEMPLATE, example: "sk_live_realkey" }),
    );
    expect(await run(["add", path])).toBe(1);
    expect(said()).toContain("unknown field");
  });
});

describe("envs doctor answers from the template", () => {
  it("names a required key that is not set", async () => {
    await run(["add", templateFile()]);
    await run(["doctor"]);
    expect(said()).toContain("STRIPE_SECRET_KEY");
    expect(said()).toContain("required by stripe/backend");
  });

  it("catches a value of the wrong shape", async () => {
    // The publishable key in the secret slot: the swap a pattern exists for.
    writeFileSync(
      join(dir, ".env"),
      "STRIPE_SECRET_KEY=pk_live_abcdefghijklmnopqrstuvwxyz\n",
    );
    await run(["load", ".env"]);
    await run(["add", templateFile()]);
    await run(["doctor"]);
    expect(said()).toContain("does not match the shape");
  });

  it("prints no value, checked against the bytes", async () => {
    const secret = "sk_live_abcdefghijklmnopqrstuvwxyz";
    writeFileSync(join(dir, ".env"), `STRIPE_SECRET_KEY=${secret}\nOTHER=plain\n`);
    await run(["load", ".env"]);
    await run(["add", templateFile()]);
    await run(["doctor"]);
    expect(said()).not.toContain(secret);
    expect(said()).not.toContain("plain");
    // and it still said something about the keys
    expect(said()).toContain("OTHER");
  });

  it("reports a key no applied template names", async () => {
    writeFileSync(join(dir, ".env"), "UNDECLARED=1\n");
    await run(["load", ".env"]);
    await run(["add", templateFile()]);
    await run(["doctor"]);
    expect(said()).toContain("named by no applied template");
  });
});

describe("envs template lint speaks for the publisher", () => {
  it("passes a template that follows the rules", async () => {
    expect(await run(["template", "lint", templateFile()])).toBe(0);
    expect(said()).toContain("stripe/backend");
  });

  it("refuses a link that leaves the provider's domain", async () => {
    const path = join(dir, "phish.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...TEMPLATE,
        keys: {
          STRIPE_SECRET_KEY: {
            required: true,
            sensitivity: "secret",
            obtain: "https://stripe.evil.test/apikeys",
          },
        },
      }),
    );
    expect(await run(["template", "lint", path])).toBe(1);
    expect(said()).toContain("not one of");
  });

  it("refuses a stranger publishing under a held namespace", async () => {
    expect(
      await run([
        "template",
        "lint",
        templateFile(),
        "--publisher",
        "someone",
      ]),
    ).toBe(1);
    expect(said()).toContain("reserved namespace");
  });
});

describe("envs migrate is the upgrade nothing does for you", () => {
  it("says when there is nothing to do", async () => {
    expect(await run(["migrate"])).toBe(0);
    expect(said()).toContain("already at schema");
  });

  /** The catalog an existing install has: one schema behind, values intact. */
  const ageTheCatalog = (): void => {
    const db = openDatabaseSync(join(dir, ".envs", "catalog.sqlite"));
    db.exec("DROP TABLE template_ref");
    db.exec("UPDATE schema_meta SET version = 3 WHERE id = 1");
    db.close();
  };

  it("refuses a catalog written by a newer build", async () => {
    // Reading it with an older understanding is how a value comes back wrong,
    // so this is refused rather than attempted.
    writeFileSync(join(dir, ".env"), "A=1\n");
    await run(["load", ".env"]);
    const db = openDatabaseSync(join(dir, ".envs", "catalog.sqlite"));
    db.exec("UPDATE schema_meta SET version = 99 WHERE id = 1");
    db.close();

    expect(await run(["get", "A"])).not.toBe(0);
    expect(said()).toContain("newer envs");
    // and it refuses before decrypting, not after
    expect(said()).not.toContain("1");
  });

  it("leaves an older catalog readable, because the change only adds", async () => {
    // Measured: the CLI does not gate reads on the schema version, and this
    // migration only adds a table. Values keep working before the upgrade.
    writeFileSync(join(dir, ".env"), "A=1\n");
    await run(["load", ".env"]);
    ageTheCatalog();

    expect(await run(["ls"])).toBe(0);
  });

  it("reports no templates on a catalog that predates the table", async () => {
    ageTheCatalog();
    expect(await run(["doctor"])).not.toBe(2);
    expect(said()).not.toContain("no such table");
  });

  it("upgrades it, and the values are still there afterwards", async () => {
    writeFileSync(join(dir, ".env"), "A=survives\n");
    await run(["load", ".env"]);
    ageTheCatalog();

    expect(await run(["migrate"])).toBe(0);
    expect(said()).toContain("schema 3 to 4");

    await run(["get", "A"]);
    expect(out.text).toContain("survives");
    expect(await run(["add", templateFile()])).toBe(0);
  });
});
