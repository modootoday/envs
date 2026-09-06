/**
 * Reading values out of a catalog. Every item is sealed under the DEK and bound
 * to its row, and the key name travels inside the envelope rather than beside
 * it, so a database opened without the key shows neither.
 */

import {
  CatalogVersionError,
  readMeta,
  SCHEMA_VERSION,
} from "../catalog/schema.js";
import { toHex } from "../crypto/digest.js";
import { open } from "../crypto/envelope.js";
import { unlockDek, type DekWrap, type Unlock } from "../crypto/keyring.js";
import type { Database } from "../sqlite/open.js";

export interface CatalogEntry {
  readonly key: string;
  readonly value: string;
  readonly sourceId: string;
  readonly alias: string;
  readonly path: string;
}

export class NoReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoReleaseError";
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Binds an item to its row, so a blob cannot be moved between them. */
export function itemContext(
  sourceId: string,
  keyHash: Uint8Array,
  revisionId: string,
): Uint8Array {
  return encoder.encode(
    `envs:item:v1:${sourceId}:${toHex(keyHash)}:${revisionId}`,
  );
}

/**
 * Reading a catalog written by a newer build is how a value comes back wrong,
 * so it is refused here rather than at whichever column first disagrees. An
 * older one is read: every migration so far only adds, and refusing would make
 * an upgrade of this CLI break a project that had not asked for one.
 */
export function assertReadable(db: Database): void {
  const meta = readMeta(db);
  if (meta !== undefined && meta.version > SCHEMA_VERSION) {
    throw new CatalogVersionError(
      meta.version,
      SCHEMA_VERSION,
      `this catalog was written by a newer envs (schema ${String(meta.version)}, this build reads ${String(SCHEMA_VERSION)}); upgrade @modootoday/envs`,
    );
  }
}

export function readWraps(db: Database): DekWrap[] {
  assertReadable(db);
  return db
    .prepare<{
      wrap_id: string;
      method: string;
      salt: Uint8Array;
      scrypt_n: number;
      scrypt_r: number;
      scrypt_p: number;
      envelope: Uint8Array;
    }>(
      "SELECT wrap_id, method, salt, scrypt_n, scrypt_r, scrypt_p, envelope FROM dek_wraps WHERE retired_at IS NULL",
    )
    .all()
    .map((row) => ({
      wrapId: row.wrap_id,
      method: row.method === "kek" ? "kek" : "recovery",
      salt: new Uint8Array(row.salt),
      n: Number(row.scrypt_n),
      r: Number(row.scrypt_r),
      p: Number(row.scrypt_p),
      envelope: new Uint8Array(row.envelope),
    }));
}

export function currentRevision(db: Database): string | undefined {
  return db
    .prepare<{ revision_id: string }>(
      "SELECT revision_id FROM pointer WHERE id = 1",
    )
    .get()?.revision_id;
}

export interface ReadOptions {
  readonly unlock: Unlock;
  /** Read a specific release instead of whatever the pointer names. */
  readonly revisionId?: string;
  /** Restrict to these source aliases, in this order. */
  readonly aliases?: readonly string[];
}

/**
 * Entries for one release, in source order. Order is what the caller uses to
 * decide a winner, so it is preserved rather than collapsed here: which file
 * declared a key is the question this store exists to answer.
 */
export function readEntries(
  db: Database,
  options: ReadOptions,
): readonly CatalogEntry[] {
  const revision = options.revisionId ?? currentRevision(db);
  if (revision === undefined) {
    throw new NoReleaseError(
      'catalog has no current release; run "envs pull" or "envs load" first',
    );
  }
  const dek = unlockDek(readWraps(db), options.unlock);

  const rows = db
    .prepare<{
      source_id: string;
      alias: string;
      path: string;
      key_hash: Uint8Array;
      envelope: Uint8Array;
    }>(
      `SELECT i.source_id, s.alias, s.path, i.key_hash, i.envelope
         FROM items i
         JOIN sources s ON s.source_id = i.source_id
        WHERE i.revision_id = $revision
          AND s.retired_at IS NULL
        ORDER BY s.added_at, s.source_id, i.rowid`,
    )
    .all({ revision });

  const wanted =
    options.aliases === undefined ? undefined : new Set(options.aliases);
  const entries: CatalogEntry[] = [];
  for (const row of rows) {
    if (wanted !== undefined && !wanted.has(row.alias)) continue;
    const plain = open({
      kek: dek,
      blob: new Uint8Array(row.envelope),
      context: itemContext(
        row.source_id,
        new Uint8Array(row.key_hash),
        revision,
      ),
    });
    const text = decoder.decode(plain);
    const split = text.indexOf("=");
    if (split <= 0) {
      throw new Error(
        `item in source ${row.alias} does not carry a key name; the catalog is corrupt`,
      );
    }
    entries.push({
      key: text.slice(0, split),
      value: text.slice(split + 1),
      sourceId: row.source_id,
      alias: row.alias,
      path: row.path,
    });
  }

  if (options.aliases === undefined) return entries;
  // Alias order is the caller's precedence, not the catalog's insertion order.
  const rank = new Map(options.aliases.map((alias, index) => [alias, index]));
  return [...entries].sort(
    (a, b) => (rank.get(a.alias) ?? 0) - (rank.get(b.alias) ?? 0),
  );
}
