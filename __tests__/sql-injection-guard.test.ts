import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/sqlite/open.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * A statement built by interpolation or concatenation. Env values are arbitrary
 * text from files this package does not control, so the invariant is that none
 * of them can reach statement text at all.
 */
function builtStatements(source: string): string[] {
  const hits: string[] = [];
  const interpolated = /\.(prepare|exec|run|query)\(\s*`[^`]*\$\{/g;
  const concatenated = /\.(prepare|exec|run|query)\(\s*["'][^"']*["']\s*\+/g;
  for (const re of [interpolated, concatenated]) {
    for (const match of source.matchAll(re)) hits.push(match[0]);
  }
  return hits;
}

describe("the detector fires", () => {
  it("catches an interpolated statement", () => {
    expect(
      builtStatements("db.prepare(`SELECT * FROM t WHERE k = '${key}'`)"),
    ).toHaveLength(1);
  });

  it("catches a concatenated statement", () => {
    expect(builtStatements('db.exec("DROP TABLE " + name)')).toHaveLength(1);
  });

  it("does not flag a plain literal", () => {
    expect(
      builtStatements('db.prepare("SELECT a FROM t WHERE k = ?")'),
    ).toHaveLength(0);
  });
});

describe("no statement in this package is built from data", () => {
  const files = sources(SRC);

  it("has sources to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(file.slice(SRC.length + 1), () => {
      expect(builtStatements(readFileSync(file, "utf8"))).toEqual([]);
    });
  }
});

describe("hostile values survive as values", () => {
  const HOSTILE = [
    "'; DROP TABLE items; --",
    '" OR 1=1 --',
    "\\'; DELETE FROM items WHERE '1'='1",
    "ab",
    "${jndi:ldap://x}",
    "-- comment\nDROP TABLE items;",
    "'||(SELECT sqlite_version())||'",
  ];

  it("stores and returns each one unchanged, and the table survives", async () => {
    const db = await openDatabase(":memory:");
    db.exec("CREATE TABLE items (k TEXT PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO items VALUES ($k, $v)");
    HOSTILE.forEach((value, index) => insert.run({ k: `k${index}`, v: value }));

    const rows = db
      .prepare<{ v: string }>("SELECT v FROM items ORDER BY k")
      .all();
    expect(rows.map((row) => row.v)).toEqual(HOSTILE);
    expect(db.prepare("SELECT count(*) AS n FROM items").get()).toEqual({
      n: HOSTILE.length,
    });
    db.close();
  });

  it("refuses a NUL rather than storing the head of the value", async () => {
    const db = await openDatabase(":memory:");
    db.exec("CREATE TABLE items (k TEXT PRIMARY KEY, v TEXT)");
    const truncating = `a${String.fromCharCode(0)}b`;
    expect(() =>
      db.prepare("INSERT INTO items VALUES ($k, $v)").run({
        k: "x",
        v: truncating,
      }),
    ).toThrow(/NUL/);
    expect(db.prepare("SELECT count(*) AS n FROM items").get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it("keeps a hostile key as a key, not as syntax", async () => {
    const db = await openDatabase(":memory:");
    db.exec("CREATE TABLE items (k TEXT PRIMARY KEY, v TEXT)");
    const hostileKey = "'; DROP TABLE items; --";
    db.prepare("INSERT INTO items VALUES ($k, $v)").run({
      k: hostileKey,
      v: "kept",
    });
    expect(
      db.prepare<{ v: string }>("SELECT v FROM items WHERE k = $k").get({
        k: hostileKey,
      }),
    ).toEqual({ v: "kept" });
    db.close();
  });
});
