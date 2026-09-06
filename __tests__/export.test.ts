import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSchema } from "../src/catalog/schema.js";
import { csvField, exportValues } from "../src/catalog/export.js";
import { hashKeyName, seal } from "../src/crypto/envelope.js";
import { createKeyring } from "../src/crypto/keyring.js";
import { itemContext } from "../src/loader/read.js";
import { openDatabaseSync } from "../src/sqlite/open.js";

const KEK = new Uint8Array(32).fill(11);
const REV = "rev1";
const AT = "2026-09-06T00:00:00.000Z";

let home: string;
let project: string;
let codes: readonly string[];

function seed(values: Record<string, string>): void {
  const path = join(project, ".envs", "catalog.sqlite");
  mkdirSync(join(project, ".envs"), { recursive: true });
  const db = openDatabaseSync(path);
  createSchema(db, { catalogId: "c", now: () => AT });

  let n = 0;
  const keyring = createKeyring({
    kek: KEK,
    recoveryCodes: 2,
    newId: () => `w-${(n += 1)}`,
  });
  codes = keyring.recoveryCodes;
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
  db.prepare(
    `INSERT INTO sources (source_id, path, alias, kind, added_at)
     VALUES ('s1', '/seeded/.env', 'base', 'file', $at)`,
  ).run({ at: AT });

  for (const [key, value] of Object.entries(values)) {
    const keyHash = hashKeyName(keyring.dek, key);
    db.prepare(
      "INSERT OR IGNORE INTO keys (key_hash, first_seen_at) VALUES ($hash, $at)",
    ).run({ hash: keyHash, at: AT });
    db.prepare(
      `INSERT INTO items (source_id, key_hash, revision_id, envelope, kek_version, created_at)
       VALUES ('s1', $hash, $rev, $envelope, 1, $at)`,
    ).run({
      hash: keyHash,
      rev: REV,
      envelope: seal({
        kek: keyring.dek,
        kekVersion: 1,
        plaintext: new TextEncoder().encode(`${key}=${value}`),
        context: itemContext("s1", keyHash, REV),
      }),
      at: AT,
    });
  }
  db.close();
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "envs-export-"));
  home = join(base, "home");
  project = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
});

afterEach(() => rmSync(join(project, ".."), { recursive: true, force: true }));

const run = (unlock: Parameters<typeof exportValues>[0]["unlock"]) =>
  exportValues({ unlock, cwd: project, home, env: {} });

describe("a recovery code opens the catalog", () => {
  it("decrypts with any minted code, without the KEK", () => {
    seed({ A: "1", B: "2" });
    for (const code of codes) {
      const result = run({ recoveryCode: code });
      expect(result.count).toBe(2);
      expect(result.text).toContain('"A","1"');
    }
  });

  it("accepts a code typed in lower case with odd spacing", () => {
    seed({ A: "1" });
    const typed = ` ${codes[0]!.toLowerCase().replace(/-/g, " ")} `;
    expect(run({ recoveryCode: typed }).count).toBe(1);
  });

  it("refuses a code that was never minted", () => {
    seed({ A: "1" });
    expect(() =>
      run({ recoveryCode: "00000-00000-00000-00000-00000-0" }),
    ).toThrow(/wraps opened/);
  });
});

describe("CSV that survives real values", () => {
  it("quotes commas, quotes and newlines rather than breaking the row", () => {
    seed({
      COMMA: "a,b",
      QUOTED: 'say "hi"',
      MULTILINE: "line1\nline2",
    });
    const text = run({ recoveryCode: codes[0]! }).text;
    expect(text).toContain('"COMMA","a,b"');
    expect(text).toContain('"QUOTED","say ""hi"""');
    expect(text).toContain('"MULTILINE","line1\nline2"');
  });

  it("has a header and one row per value", () => {
    seed({ A: "1", B: "2" });
    const lines = run({ recoveryCode: codes[0]! }).text.trimEnd().split("\r\n");
    expect(lines[0]).toBe('"key","value","source","path","layer"');
    expect(lines).toHaveLength(3);
  });

  it("escapes every field the same way, including the source", () => {
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField("")).toBe('""');
  });
});

describe("values a spreadsheet would run", () => {
  it("reports them instead of rewriting them", () => {
    seed({ SAFE: "ok", FORMULA: "=1+1", CMD: "@SUM(A1)", NEG: "-2" });
    const result = run({ recoveryCode: codes[0]! });
    expect(result.formulaKeys.sort()).toEqual(["CMD", "FORMULA", "NEG"]);
    // The value is exported as stored: altering it would hand back something
    // that is not what the catalog holds.
    expect(result.text).toContain('"FORMULA","=1+1"');
  });
});

describe("other formats", () => {
  it("writes an env file whose values are quoted", () => {
    seed({ A: "has space", B: "x" });
    const text = exportValues({
      unlock: { recoveryCode: codes[0]! },
      cwd: project,
      home,
      env: {},
      format: "env",
    }).text;
    expect(text).toContain('A="has space"');
  });

  it("writes json keyed by name", () => {
    seed({ A: "1" });
    const text = exportValues({
      unlock: { recoveryCode: codes[0]! },
      cwd: project,
      home,
      env: {},
      format: "json",
    }).text;
    expect(JSON.parse(text)).toEqual({ A: "1" });
  });
});

describe("scope", () => {
  it("names the catalogs it read, so the reader knows which store this was", () => {
    seed({ A: "1" });
    expect(run({ recoveryCode: codes[0]! }).catalogs).toEqual([
      join(project, ".envs", "catalog.sqlite"),
    ]);
  });

  it("leaves the machine-wide layer out unless asked", () => {
    seed({ A: "1" });
    expect(run({ recoveryCode: codes[0]! }).catalogs).toHaveLength(1);
  });
});
