/**
 * Catalog schema and its version gate. Statements are literals; nothing a
 * caller supplies reaches statement text.
 */

import {
  openDatabase,
  type Database,
  type OpenOptions,
} from "../sqlite/open.js";

export const SCHEMA_VERSION = 3;

export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

/**
 * items carries source_id in its key because a value's origin is what a layered
 * tool is asked about. A global key column cannot say which file a value came
 * from, nor that two files declared it.
 */
const V1: readonly string[] = [
  `CREATE TABLE schema_meta (
     id           INTEGER PRIMARY KEY CHECK (id = 1),
     version      INTEGER NOT NULL,
     catalog_id   TEXT    NOT NULL,
     created_at   TEXT    NOT NULL
   )`,
  `CREATE TABLE sources (
     source_id     TEXT PRIMARY KEY,
     path          TEXT NOT NULL UNIQUE,
     alias         TEXT NOT NULL UNIQUE,
     kind          TEXT NOT NULL,
     digest        TEXT,
     added_at      TEXT NOT NULL,
     last_seen_at  TEXT,
     retired_at    TEXT
   )`,
  // A retired alias is never reused: the same name must not come to mean a
  // different file for a script that already refers to it.
  `CREATE TABLE alias_retired (
     alias       TEXT PRIMARY KEY,
     source_id   TEXT NOT NULL,
     retired_at  TEXT NOT NULL
   )`,
  // Names are stored as HMACs. Opening the file without the key shows neither
  // values nor which keys exist.
  `CREATE TABLE keys (
     key_hash       BLOB PRIMARY KEY,
     first_seen_at  TEXT NOT NULL
   )`,
  `CREATE TABLE releases (
     revision_id  TEXT PRIMARY KEY,
     created_at   TEXT NOT NULL,
     note         TEXT
   )`,
  `CREATE TABLE items (
     source_id    TEXT NOT NULL REFERENCES sources (source_id),
     key_hash     BLOB NOT NULL REFERENCES keys (key_hash),
     revision_id  TEXT NOT NULL REFERENCES releases (revision_id),
     envelope     BLOB NOT NULL,
     kek_version  INTEGER NOT NULL,
     created_at   TEXT NOT NULL,
     PRIMARY KEY (source_id, key_hash, revision_id)
   )`,
  `CREATE INDEX items_by_revision ON items (revision_id)`,
  `CREATE INDEX items_by_key ON items (key_hash)`,
  // One row. The pointer is what a rollback moves.
  `CREATE TABLE pointer (
     id           INTEGER PRIMARY KEY CHECK (id = 1),
     revision_id  TEXT NOT NULL REFERENCES releases (revision_id),
     updated_at   TEXT NOT NULL
   )`,
  `CREATE TABLE audit (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     at       TEXT NOT NULL,
     action   TEXT NOT NULL,
     subject  TEXT,
     detail   TEXT
   )`,
  `CREATE TABLE kek_history (
     version      INTEGER PRIMARY KEY,
     fingerprint  TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     retired_at   TEXT
   )`,
  // One row per way of recovering the DEK: the KEK, and each recovery code.
  // Only the wrapped DEK is here. A recovery code is printed once at init and
  // never stored, so this table cannot give one back.
  `CREATE TABLE dek_wraps (
     wrap_id     TEXT PRIMARY KEY,
     method      TEXT NOT NULL CHECK (method IN ('kek', 'recovery')),
     salt        BLOB NOT NULL,
     scrypt_n    INTEGER NOT NULL,
     scrypt_r    INTEGER NOT NULL,
     scrypt_p    INTEGER NOT NULL,
     envelope    BLOB NOT NULL,
     created_at  TEXT NOT NULL,
     last_used_at TEXT,
     retired_at  TEXT
   )`,
];

/**
 * Watch targets are what to look at, not what has been loaded: a directory or a
 * pattern that has no source row yet. Excludes live in the same table so one
 * ordering rule covers both.
 */
const V2: readonly string[] = [
  `CREATE TABLE watch_targets (
     target_id  TEXT PRIMARY KEY,
     pattern    TEXT NOT NULL UNIQUE,
     mode       TEXT NOT NULL CHECK (mode IN ('include', 'exclude')),
     added_at   TEXT NOT NULL
   )`,
];

/**
 * What a key may be exposed to. Unset reads as "medium", so a key nobody
 * classified is never baked into a build — the safe answer is the default.
 */
const V3: readonly string[] = [`ALTER TABLE keys ADD COLUMN sensitivity TEXT`];

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: V1 },
  { version: 2, statements: V2 },
  { version: 3, statements: V3 },
];

export class CatalogVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
    message: string,
  ) {
    super(message);
    this.name = "CatalogVersionError";
  }
}

export interface CatalogMeta {
  readonly version: number;
  readonly catalogId: string;
  readonly createdAt: string;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = $name",
    )
    .get({ name });
  return (row?.n ?? 0) > 0;
}

export function readMeta(db: Database): CatalogMeta | undefined {
  if (!tableExists(db, "schema_meta")) return undefined;
  const row = db
    .prepare<{ version: number; catalog_id: string; created_at: string }>(
      "SELECT version, catalog_id, created_at FROM schema_meta WHERE id = 1",
    )
    .get();
  if (row === undefined) return undefined;
  return {
    version: Number(row.version),
    catalogId: row.catalog_id,
    createdAt: row.created_at,
  };
}

function applyMigrations(db: Database, from: number, to: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version <= from || migration.version > to) continue;
    for (const statement of migration.statements) db.exec(statement);
  }
}

export interface CreateOptions {
  readonly catalogId?: string;
  readonly now?: () => string;
}

/** Build an empty catalog at the current version. */
export function createSchema(
  db: Database,
  options: CreateOptions = {},
): CatalogMeta {
  const catalogId = options.catalogId ?? crypto.randomUUID();
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  db.transaction(() => {
    applyMigrations(db, 0, SCHEMA_VERSION);
    db.prepare(
      "INSERT INTO schema_meta (id, version, catalog_id, created_at) VALUES (1, $version, $catalogId, $createdAt)",
    ).run({ version: SCHEMA_VERSION, catalogId, createdAt });
  });
  return { version: SCHEMA_VERSION, catalogId, createdAt };
}

/**
 * A catalog newer than this build is refused rather than read: reading it with
 * an older understanding is how a value comes back wrong. An older one is
 * reported, never migrated as a side effect of being opened -- one run of a
 * floating CLI must not upgrade a catalog another project has pinned.
 */
export function checkVersion(meta: CatalogMeta): void {
  if (meta.version > SCHEMA_VERSION) {
    throw new CatalogVersionError(
      meta.version,
      SCHEMA_VERSION,
      `catalog is at schema ${meta.version} and this build understands ${SCHEMA_VERSION}; upgrade @modootoday/envs`,
    );
  }
  if (meta.version < SCHEMA_VERSION) {
    throw new CatalogVersionError(
      meta.version,
      SCHEMA_VERSION,
      `catalog is at schema ${meta.version} and this build is at ${SCHEMA_VERSION}; run "envs migrate" to upgrade it`,
    );
  }
}

export interface OpenCatalogOptions extends OpenOptions {
  /** Create the schema when the file holds none. Off for read paths. */
  readonly create?: boolean;
  readonly catalogId?: string;
  readonly now?: () => string;
}

export interface OpenedCatalog {
  readonly db: Database;
  readonly meta: CatalogMeta;
}

export async function openCatalog(
  path: string,
  options: OpenCatalogOptions = {},
): Promise<OpenedCatalog> {
  const db = await openDatabase(path, options);
  let meta = readMeta(db);
  if (meta === undefined) {
    if (options.create !== true) {
      db.close();
      throw new CatalogVersionError(
        0,
        SCHEMA_VERSION,
        `no catalog at ${path}; run "envs init" first`,
      );
    }
    meta = createSchema(db, options);
  } else {
    try {
      checkVersion(meta);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  return { db, meta };
}

/** Bring an older catalog up to this build's version, on purpose. */
export function migrate(db: Database): CatalogMeta {
  const meta = readMeta(db);
  if (meta === undefined) {
    throw new CatalogVersionError(0, SCHEMA_VERSION, "no catalog to migrate");
  }
  if (meta.version > SCHEMA_VERSION) {
    throw new CatalogVersionError(
      meta.version,
      SCHEMA_VERSION,
      `catalog is at schema ${meta.version}, newer than this build`,
    );
  }
  if (meta.version === SCHEMA_VERSION) return meta;
  db.transaction(() => {
    applyMigrations(db, meta.version, SCHEMA_VERSION);
    db.prepare("UPDATE schema_meta SET version = $version WHERE id = 1").run({
      version: SCHEMA_VERSION,
    });
  });
  return { ...meta, version: SCHEMA_VERSION };
}
