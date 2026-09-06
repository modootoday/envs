import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seal, hashKeyName } from "../src/crypto/envelope.js";
import { createKeyring } from "../src/crypto/keyring.js";
import { config } from "../src/loader/config.js";
import { itemContext } from "../src/loader/read.js";
import { createSchema } from "../src/catalog/schema.js";
import { openDatabaseSync } from "../src/sqlite/open.js";

const KEK = new Uint8Array(32).fill(11);
const KEK_B64 = Buffer.from(KEK).toString("base64");
const REV = "rev1";
const AT = "2026-09-06T00:00:00.000Z";

let home: string;
let project: string;

/**
 * Seeds a catalog with literal SQL rather than a writer from src, so what is
 * being tested is resolution and not a writer agreeing with its own reader.
 */
function seed(
  catalogPath: string,
  sources: ReadonlyArray<{ alias: string; values: Record<string, string> }>,
): void {
  mkdirSync(join(catalogPath, ".."), { recursive: true });
  const db = openDatabaseSync(catalogPath);
  createSchema(db, { catalogId: catalogPath, now: () => AT });

  const keyring = createKeyring({
    kek: KEK,
    recoveryCodes: 1,
    newId: () => `w-${Math.random()}`,
  });
  for (const wrap of keyring.wraps) {
    db.prepare(
      `INSERT INTO dek_wraps (wrap_id, method, salt, scrypt_n, scrypt_r, scrypt_p, envelope, created_at)
       VALUES ($id, $method, $salt, $n, $r, $p, $envelope, $at)`,
    ).run({
      id: wrap.wrapId,
      method: wrap.method,
      salt: wrap.salt,
      n: wrap.n,
      r: wrap.r,
      p: wrap.p,
      envelope: wrap.envelope,
      at: AT,
    });
  }

  db.prepare(
    "INSERT INTO releases (revision_id, created_at) VALUES ($rev, $at)",
  ).run({ rev: REV, at: AT });
  db.prepare(
    "INSERT INTO pointer (id, revision_id, updated_at) VALUES (1, $rev, $at)",
  ).run({ rev: REV, at: AT });

  sources.forEach((source, index) => {
    const sourceId = `${source.alias}-id`;
    db.prepare(
      `INSERT INTO sources (source_id, path, alias, kind, added_at)
       VALUES ($id, $path, $alias, 'file', $at)`,
    ).run({
      id: sourceId,
      path: `/seeded/${source.alias}/.env`,
      alias: source.alias,
      // added_at orders the sources, so it must differ per source.
      at: `2026-09-0${index + 1}T00:00:00.000Z`,
    });
    for (const [key, value] of Object.entries(source.values)) {
      const keyHash = hashKeyName(keyring.dek, key);
      db.prepare(
        "INSERT OR IGNORE INTO keys (key_hash, first_seen_at) VALUES ($hash, $at)",
      ).run({ hash: keyHash, at: AT });
      db.prepare(
        `INSERT INTO items (source_id, key_hash, revision_id, envelope, kek_version, created_at)
         VALUES ($source, $hash, $rev, $envelope, 1, $at)`,
      ).run({
        source: sourceId,
        hash: keyHash,
        rev: REV,
        envelope: seal({
          kek: keyring.dek,
          kekVersion: 1,
          plaintext: new TextEncoder().encode(`${key}=${value}`),
          context: itemContext(sourceId, keyHash, REV),
        }),
        at: AT,
      });
    }
  });
  db.close();
}

const projectCatalog = (): string => join(project, ".envs", "catalog.sqlite");
const globalCatalog = (): string => join(home, ".envs", "catalog.sqlite");

function run(options: Parameters<typeof config>[0] = {}) {
  return config({
    cwd: project,
    home,
    env: { ENVS_KEK: KEK_B64 },
    processEnv: {},
    ...options,
  });
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "envs-config-"));
  home = join(base, "home");
  project = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
});

afterEach(() => {
  rmSync(join(project, ".."), { recursive: true, force: true });
});

describe("reading the project store", () => {
  it("returns the values and puts them in the target environment", () => {
    seed(projectCatalog(), [{ alias: "base", values: { A: "1", B: "2" } }]);
    const target: Record<string, string | undefined> = {};
    const result = run({ processEnv: target });
    expect(result.error).toBeUndefined();
    expect(result.parsed).toEqual({ A: "1", B: "2" });
    expect(target).toEqual({ A: "1", B: "2" });
  });

  it("says what to do when there is no release yet", () => {
    const db = openDatabaseSync(projectCatalogEnsured());
    createSchema(db, { catalogId: "c", now: () => AT });
    db.close();
    expect(run().error?.message).toMatch(/no current release/);
  });

  function projectCatalogEnsured(): string {
    mkdirSync(join(project, ".envs"), { recursive: true });
    return projectCatalog();
  }

  it("keeps values sealed when no key is available", () => {
    seed(projectCatalog(), [{ alias: "base", values: { A: "1" } }]);
    expect(run({ env: {} }).error?.message).toMatch(/no key available/);
  });
});

describe("the two layers", () => {
  beforeEach(() => {
    seed(projectCatalog(), [
      { alias: "proj", values: { SHARED: "project", ONLY_P: "p" } },
    ]);
    seed(globalCatalog(), [
      { alias: "glob", values: { SHARED: "global", ONLY_G: "g" } },
    ]);
  });

  it("lets the project win and the global fill the gaps", () => {
    expect(run().parsed).toEqual({
      SHARED: "project",
      ONLY_P: "p",
      ONLY_G: "g",
    });
  });

  it("names the layer each key came from", () => {
    const byKey = new Map(run().provenance!.map((p) => [p.key, p.layer]));
    expect(byKey.get("SHARED")).toBe("project");
    expect(byKey.get("ONLY_G")).toBe("global");
  });

  it("drops the global layer entirely when it is switched off", () => {
    expect(run({ global: false }).parsed).toEqual({
      SHARED: "project",
      ONLY_P: "p",
    });
  });

  it("honours ENVS_NO_GLOBAL, which is what CI sets", () => {
    const result = run({ env: { ENVS_KEK: KEK_B64, ENVS_NO_GLOBAL: "1" } });
    expect(result.parsed).toEqual({ SHARED: "project", ONLY_P: "p" });
  });

  it("throws on a cross-layer conflict when asked to", () => {
    expect(run({ onConflict: "throw" }).error?.message).toMatch(
      /"SHARED" is declared by project/,
    );
  });
});

describe("no project root", () => {
  it("reads the home catalog as the only layer", () => {
    seed(globalCatalog(), [{ alias: "glob", values: { ONLY_G: "g" } }]);
    const bare = mkdtempSync(join(tmpdir(), "envs-bare-"));
    const result = config({
      cwd: bare,
      home,
      env: { ENVS_KEK: KEK_B64 },
      processEnv: {},
    });
    expect(result.parsed).toEqual({ ONLY_G: "g" });
    expect(result.provenance?.[0]?.layer).toBe("project");
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("dotenv precedence", () => {
  beforeEach(() => {
    seed(projectCatalog(), [{ alias: "proj", values: { A: "from-store" } }]);
  });

  it("leaves a value already in the environment alone", () => {
    const target: Record<string, string | undefined> = { A: "from-process" };
    run({ processEnv: target });
    expect(target["A"]).toBe("from-process");
  });

  it("replaces it when override is set", () => {
    const target: Record<string, string | undefined> = { A: "from-process" };
    run({ processEnv: target, override: true });
    expect(target["A"]).toBe("from-store");
  });

  it("reports process.env as the layer that won", () => {
    const result = run({ processEnv: { A: "from-process" } });
    expect(result.provenance).toEqual([
      { key: "A", layer: "process", from: "process.env" },
    ]);
  });
});

describe("files, when a path is given", () => {
  it("reads them ahead of the store, first declaration winning", () => {
    seed(projectCatalog(), [{ alias: "proj", values: { A: "store" } }]);
    const file = join(project, "extra.env");
    writeFileSync(file, "A=file\nONLY_F=f\n");
    expect(run({ path: file }).parsed).toEqual({ A: "file", ONLY_F: "f" });
  });

  it("refuses a file that is not env format instead of loading part of it", () => {
    seed(projectCatalog(), [{ alias: "proj", values: { A: "store" } }]);
    const file = join(project, "config.yaml");
    writeFileSync(file, "name: envs\nversion: 1\n");
    const result = run({ path: file });
    expect(result.parsed).toBeUndefined();
    expect(result.error?.message).toMatch(/not env format/);
  });

  it("ignores a path that does not exist, as dotenv does", () => {
    seed(projectCatalog(), [{ alias: "proj", values: { A: "store" } }]);
    expect(run({ path: join(project, "absent.env") }).parsed).toEqual({
      A: "store",
    });
  });
});

describe("selecting sources by alias", () => {
  beforeEach(() => {
    seed(projectCatalog(), [
      { alias: "base", values: { A: "base", ONLY_BASE: "b" } },
      { alias: "app", values: { A: "app", ONLY_APP: "a" } },
    ]);
  });

  it("loads only the aliases named", () => {
    expect(run({ aliases: ["app"] }).parsed).toEqual({
      A: "app",
      ONLY_APP: "a",
    });
  });

  it("uses the array order as the precedence, not the catalog's", () => {
    expect(run({ aliases: ["app", "base"] }).parsed?.["A"]).toBe("app");
    expect(run({ aliases: ["base", "app"] }).parsed?.["A"]).toBe("base");
  });
});
