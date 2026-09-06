import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  CatalogVersionError,
  SCHEMA_VERSION,
  checkVersion,
  createSchema,
  migrate,
  openCatalog,
  readMeta,
} from "../src/catalog/schema.js";
import { openDatabase, type Database } from "../src/sqlite/open.js";

const dir = mkdtempSync(join(tmpdir(), "envs-catalog-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function fresh(): Promise<Database> {
  const db = await openDatabase(":memory:");
  createSchema(db, {
    catalogId: "cat-1",
    now: () => "2026-09-06T00:00:00.000Z",
  });
  return db;
}

const tables = (db: Database): string[] =>
  db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

describe("the schema it creates", () => {
  it("has exactly the tables this version declares", async () => {
    const db = await fresh();
    expect(tables(db)).toEqual([
      "alias_retired",
      "audit",
      "dek_wraps",
      "items",
      "kek_history",
      "keys",
      "pointer",
      "releases",
      "schema_meta",
      "sources",
      "sqlite_sequence",
      "watch_targets",
    ]);
    db.close();
  });

  it("carries the sensitivity column build gates on", async () => {
    const db = await fresh();
    const columns = db
      .prepare<{ name: string }>("PRAGMA table_info(keys)")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("sensitivity");
    db.close();
  });
  it("records its version and identity", async () => {
    const db = await fresh();
    expect(readMeta(db)).toEqual({
      version: SCHEMA_VERSION,
      catalogId: "cat-1",
      createdAt: "2026-09-06T00:00:00.000Z",
    });
    db.close();
  });

  it("holds one meta row and one pointer row, not more", async () => {
    const db = await fresh();
    expect(() =>
      db
        .prepare(
          "INSERT INTO schema_meta (id, version, catalog_id, created_at) VALUES (2, 1, 'x', 'y')",
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe("provenance is in the key, not alongside it", () => {
  async function seeded(): Promise<Database> {
    const db = await fresh();
    db.prepare(
      "INSERT INTO releases (revision_id, created_at) VALUES ($id, $at)",
    ).run({ id: "rev1", at: "2026-09-06T00:00:00.000Z" });
    for (const source of ["src-a", "src-b"]) {
      db.prepare(
        "INSERT INTO sources (source_id, path, alias, kind, added_at) VALUES ($id, $path, $alias, 'file', $at)",
      ).run({
        id: source,
        path: `/tmp/${source}/.env`,
        alias: source,
        at: "2026-09-06T00:00:00.000Z",
      });
    }
    db.prepare(
      "INSERT INTO keys (key_hash, first_seen_at) VALUES ($hash, $at)",
    ).run({
      hash: new Uint8Array([1, 2, 3]),
      at: "2026-09-06T00:00:00.000Z",
    });
    return db;
  }

  it("keeps both files' claim on the same key", async () => {
    const db = await seeded();
    const insert = db.prepare(
      "INSERT INTO items (source_id, key_hash, revision_id, envelope, kek_version, created_at) VALUES ($source, $hash, 'rev1', $envelope, 1, $at)",
    );
    for (const source of ["src-a", "src-b"]) {
      insert.run({
        source,
        hash: new Uint8Array([1, 2, 3]),
        envelope: new Uint8Array([9, 9]),
        at: "2026-09-06T00:00:00.000Z",
      });
    }
    expect(db.prepare("SELECT count(*) AS n FROM items").get()).toEqual({
      n: 2,
    });
    db.close();
  });

  it("refuses an item whose source was never registered", async () => {
    const db = await seeded();
    db.exec("PRAGMA foreign_keys = ON");
    expect(() =>
      db
        .prepare(
          "INSERT INTO items (source_id, key_hash, revision_id, envelope, kek_version, created_at) VALUES ('ghost', $hash, 'rev1', $envelope, 1, $at)",
        )
        .run({
          hash: new Uint8Array([1, 2, 3]),
          envelope: new Uint8Array([9]),
          at: "2026-09-06T00:00:00.000Z",
        }),
    ).toThrow();
    db.close();
  });

  it("keeps aliases unique and retired ones out of reuse", async () => {
    const db = await seeded();
    expect(() =>
      db
        .prepare(
          "INSERT INTO sources (source_id, path, alias, kind, added_at) VALUES ('src-c', '/tmp/other/.env', 'src-a', 'file', $at)",
        )
        .run({ at: "2026-09-06T00:00:00.000Z" }),
    ).toThrow();
    db.close();
  });
});

describe("the version gate", () => {
  it("accepts the version this build writes", () => {
    expect(() =>
      checkVersion({
        version: SCHEMA_VERSION,
        catalogId: "c",
        createdAt: "t",
      }),
    ).not.toThrow();
  });

  it("refuses a newer catalog instead of reading it", () => {
    expect(() =>
      checkVersion({
        version: SCHEMA_VERSION + 1,
        catalogId: "c",
        createdAt: "t",
      }),
    ).toThrow(/upgrade @modootoday\/envs/);
  });

  it("refuses an older catalog and names the command, rather than upgrading it", () => {
    expect(() =>
      checkVersion({ version: 0, catalogId: "c", createdAt: "t" }),
    ).toThrow(/envs migrate/);
  });

  it("leaves an already-current catalog untouched when migrated", async () => {
    const db = await fresh();
    expect(migrate(db).version).toBe(SCHEMA_VERSION);
    db.close();
  });
});

describe("opening a catalog file", () => {
  it("refuses to create one unless asked", async () => {
    await expect(openCatalog(join(dir, "absent.sqlite"), {})).rejects.toThrow(
      /envs init/,
    );
  });

  it("creates one when asked, and reopens it without creating again", async () => {
    const path = join(dir, "made.sqlite");
    const first = await openCatalog(path, { create: true, catalogId: "cat-x" });
    expect(first.meta.catalogId).toBe("cat-x");
    first.db.close();

    const second = await openCatalog(path, {});
    expect(second.meta.catalogId).toBe("cat-x");
    second.db.close();
  });

  it("closes the handle when it refuses a version", async () => {
    const path = join(dir, "future.sqlite");
    const made = await openCatalog(path, { create: true });
    made.db.prepare("UPDATE schema_meta SET version = $v WHERE id = 1").run({
      v: SCHEMA_VERSION + 5,
    });
    made.db.close();

    await expect(openCatalog(path, {})).rejects.toThrow(CatalogVersionError);
    // A handle left open would keep the -wal file locked; reopening read-only
    // is what proves it was released.
    const reopened = await openDatabase(path, { readOnly: true });
    expect(
      reopened
        .prepare<{ version: number }>(
          "SELECT version FROM schema_meta WHERE id = 1",
        )
        .get()?.version,
    ).toBe(SCHEMA_VERSION + 5);
    reopened.close();
  });
});
