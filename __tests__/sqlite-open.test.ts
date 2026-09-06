import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  availableBackends,
  openDatabase,
  scanPlaceholders,
  SqliteBindError,
  type Database,
  type SqliteBackend,
} from "../src/sqlite/open.js";

const dir = mkdtempSync(join(tmpdir(), "envs-sqlite-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const backends = await availableBackends();

describe("backend resolution", () => {
  it("finds at least one backend, and the built-in for this runtime", () => {
    expect(backends.length).toBeGreaterThan(0);
    const isBun =
      typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
    expect(backends).toContain(isBun ? "bun" : "node");
  });

  it("refuses a backend name it does not have", async () => {
    await expect(
      openDatabase(":memory:", { backend: "sqlite4" as SqliteBackend }),
    ).rejects.toThrow(/not one of/);
  });
});

describe.each(backends)("backend %s", (backend: SqliteBackend) => {
  const open = (path: string, readOnly = false): Promise<Database> =>
    openDatabase(path, { backend, readOnly });

  async function seeded(): Promise<Database> {
    const db = await open(":memory:");
    db.exec("CREATE TABLE t (a INTEGER, b TEXT)");
    return db;
  }

  it("reports the backend it was asked for", async () => {
    const db = await open(":memory:");
    expect(db.backend).toBe(backend);
    db.close();
  });

  it("stores a boolean as 1 and 0", async () => {
    const db = await seeded();
    db.prepare("INSERT INTO t VALUES (?, ?)").run([true, "yes"]);
    db.prepare("INSERT INTO t VALUES (?, ?)").run([false, "no"]);
    expect(db.prepare("SELECT a FROM t ORDER BY b").all()).toEqual([
      { a: 0 },
      { a: 1 },
    ]);
    db.close();
  });

  it("refuses undefined instead of storing NULL for it", async () => {
    const db = await seeded();
    expect(() =>
      db.prepare("INSERT INTO t VALUES (?, ?)").run([undefined as never, "x"]),
    ).toThrow(SqliteBindError);
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
    db.close();
  });

  it("reports a missing row as undefined, not null", async () => {
    const db = await seeded();
    const row = db.prepare("SELECT a FROM t WHERE a = 999").get();
    expect(row).toBeUndefined();
    expect(row).not.toBeNull();
    db.close();
  });

  it("stores an explicit null", async () => {
    const db = await seeded();
    db.prepare("INSERT INTO t VALUES (?, ?)").run([null, null]);
    expect(db.prepare("SELECT a, b FROM t").get()).toEqual({
      a: null,
      b: null,
    });
    db.close();
  });

  it("binds named parameters given either with the sigil or without", async () => {
    const db = await seeded();
    db.prepare("INSERT INTO t VALUES ($a, $b)").run({ $a: 7, $b: "seven" });
    db.prepare("INSERT INTO t VALUES ($a, $b)").run({ a: 8, b: "eight" });
    db.prepare("INSERT INTO t VALUES (:a, :b)").run({ a: 9, b: "nine" });
    expect(db.prepare("SELECT a, b FROM t ORDER BY a").all()).toEqual([
      { a: 7, b: "seven" },
      { a: 8, b: "eight" },
      { a: 9, b: "nine" },
    ]);
    db.close();
  });

  it("refuses a parameter with no placeholder rather than binding nothing", async () => {
    const db = await seeded();
    expect(() =>
      db.prepare("INSERT INTO t VALUES ($a, $b)").run({ a: 1, b: "x", c: 2 }),
    ).toThrow(SqliteBindError);
    db.close();
  });

  it("refuses a placeholder left without a value", async () => {
    const db = await seeded();
    expect(() =>
      db.prepare("INSERT INTO t VALUES ($a, $b)").run({ a: 1 }),
    ).toThrow(/no value/);
    db.close();
  });

  it("commits when a transaction body returns", async () => {
    const db = await seeded();
    expect(
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (?, ?)").run([1, "a"]);
        return "done";
      }),
    ).toBe("done");
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
    db.close();
  });

  it("rolls back when a transaction body throws, and rethrows", async () => {
    const db = await seeded();
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (?, ?)").run([1, "a"]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
    db.close();
  });

  it("refuses to nest rather than committing an inner half", async () => {
    const db = await seeded();
    expect(() =>
      db.transaction(() => {
        db.transaction(() => undefined);
      }),
    ).toThrow("not nestable");
    db.close();
  });

  it("opens WAL on disk", async () => {
    const path = join(dir, `${backend}-wal.sqlite`);
    const db = await open(path);
    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run([1]);
    expect(existsSync(`${path}-wal`)).toBe(true);
    db.close();
  });

  it("opens read-only as read-only, not merely with the flag set", async () => {
    const path = join(dir, `${backend}-ro.sqlite`);
    const writable = await open(path);
    writable.exec("CREATE TABLE t (a INTEGER)");
    writable.close();

    const db = await open(path, true);
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
    expect(() => db.prepare("INSERT INTO t VALUES (?)").run([1])).toThrow();
    db.close();
  });

  it("does not ask an in-memory database for WAL", async () => {
    const db = await open(":memory:");
    expect(
      db.prepare<{ journal_mode: string }>("PRAGMA journal_mode").get()
        ?.journal_mode,
    ).toBe("memory");
    db.close();
  });
});

describe("placeholder scanning", () => {
  it("finds each sigil form", () => {
    expect([...scanPlaceholders("SELECT $a, :b, @c").entries()]).toEqual([
      ["a", "$a"],
      ["b", ":b"],
      ["c", "@c"],
    ]);
  });

  it("ignores what is inside string literals and comments", () => {
    const sql = "SELECT ':notme', \"$norme\" -- @nope\n /* :also */ , $real";
    expect([...scanPlaceholders(sql).keys()]).toEqual(["real"]);
  });

  it("does not mistake a bare sigil for a placeholder", () => {
    expect(scanPlaceholders("SELECT a : b").size).toBe(0);
  });
});
