/**
 * Writing to the catalog. A release is immutable: changing a value makes a new
 * revision carrying every item, and the pointer moves. That is what makes a
 * rollback a pointer move rather than a restore.
 */

import { randomUUID } from "node:crypto";

import { hashKeyName, seal } from "../crypto/envelope.js";
import type { DekWrap } from "../crypto/keyring.js";
import { itemContext } from "../loader/read.js";
import type { Database } from "../sqlite/open.js";
import { checkAlias, deriveAlias } from "./alias.js";

const encoder = new TextEncoder();

export interface Clock {
  readonly now: () => string;
  readonly newId: () => string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

export function writeWraps(
  db: Database,
  wraps: readonly DekWrap[],
  clock: Clock = systemClock,
): void {
  const insert = db.prepare(
    `INSERT INTO dek_wraps (wrap_id, method, salt, scrypt_n, scrypt_r, scrypt_p, envelope, created_at)
     VALUES ($id, $method, $salt, $n, $r, $p, $envelope, $at)`,
  );
  const at = clock.now();
  for (const wrap of wraps) {
    insert.run({
      id: wrap.wrapId,
      method: wrap.method,
      salt: wrap.salt,
      n: wrap.n,
      r: wrap.r,
      p: wrap.p,
      envelope: wrap.envelope,
      at,
    });
  }
}

export function audit(
  db: Database,
  action: string,
  subject?: string,
  detail?: string,
  clock: Clock = systemClock,
): void {
  // Never a value. The audit trail says what happened to which key, not what
  // the key holds.
  db.prepare(
    "INSERT INTO audit (at, action, subject, detail) VALUES ($at, $action, $subject, $detail)",
  ).run({
    at: clock.now(),
    action,
    subject: subject ?? null,
    detail: detail ?? null,
  });
}

export function takenAliases(db: Database): Set<string> {
  const live = db
    .prepare<{ alias: string }>("SELECT alias FROM sources")
    .all()
    .map((row) => row.alias);
  const retired = db
    .prepare<{ alias: string }>("SELECT alias FROM alias_retired")
    .all()
    .map((row) => row.alias);
  return new Set([...live, ...retired]);
}

export interface SourceRow {
  readonly sourceId: string;
  readonly alias: string;
  readonly path: string;
}

/**
 * A path already registered keeps the alias it was given. Re-deriving on every
 * load would renumber other sources when one is added or removed.
 */
export function ensureSource(
  db: Database,
  path: string,
  options: { alias?: string; digest?: string; clock?: Clock } = {},
): SourceRow {
  const clock = options.clock ?? systemClock;
  const existing = db
    .prepare<{ source_id: string; alias: string }>(
      "SELECT source_id, alias FROM sources WHERE path = $path",
    )
    .get({ path });
  if (existing !== undefined) {
    db.prepare(
      "UPDATE sources SET last_seen_at = $at, digest = $digest, retired_at = NULL WHERE path = $path",
    ).run({ at: clock.now(), digest: options.digest ?? null, path });
    return { sourceId: existing.source_id, alias: existing.alias, path };
  }

  const taken = takenAliases(db);
  const alias = options.alias ?? deriveAlias(path, { taken });
  checkAlias(alias, taken);

  const sourceId = clock.newId();
  db.prepare(
    `INSERT INTO sources (source_id, path, alias, kind, digest, added_at, last_seen_at)
     VALUES ($id, $path, $alias, 'file', $digest, $at, $at)`,
  ).run({
    id: sourceId,
    path,
    alias,
    digest: options.digest ?? null,
    at: clock.now(),
  });
  audit(db, "source.add", alias, path, clock);
  return { sourceId, alias, path };
}

export function retireSource(
  db: Database,
  alias: string,
  clock: Clock = systemClock,
): boolean {
  const row = db
    .prepare<{ source_id: string }>(
      "SELECT source_id FROM sources WHERE alias = $alias AND retired_at IS NULL",
    )
    .get({ alias });
  if (row === undefined) return false;
  const at = clock.now();
  db.transaction(() => {
    db.prepare("UPDATE sources SET retired_at = $at WHERE source_id = $id").run(
      { at, id: row.source_id },
    );
    // Kept out of reuse: the same name must not later mean another file.
    db.prepare(
      "INSERT OR IGNORE INTO alias_retired (alias, source_id, retired_at) VALUES ($alias, $id, $at)",
    ).run({ alias, id: row.source_id, at });
    audit(db, "source.retire", alias, undefined, clock);
  });
  return true;
}

export function currentRevisionId(db: Database): string | undefined {
  return db
    .prepare<{ revision_id: string }>(
      "SELECT revision_id FROM pointer WHERE id = 1",
    )
    .get()?.revision_id;
}

export interface ItemInput {
  readonly sourceId: string;
  readonly key: string;
  readonly value: string;
}

export interface ReleaseResult {
  readonly revisionId: string;
  readonly count: number;
}

/**
 * Writes one release and moves the pointer to it, in a single transaction: a
 * half-written release that the pointer already names would be read as complete.
 */
export function writeRelease(
  db: Database,
  dek: Uint8Array,
  items: readonly ItemInput[],
  options: { note?: string; clock?: Clock; movePointer?: boolean } = {},
): ReleaseResult {
  const clock = options.clock ?? systemClock;
  const revisionId = clock.newId();
  const at = clock.now();

  db.transaction(() => {
    db.prepare(
      "INSERT INTO releases (revision_id, created_at, note) VALUES ($rev, $at, $note)",
    ).run({ rev: revisionId, at, note: options.note ?? null });

    const insertKey = db.prepare(
      "INSERT OR IGNORE INTO keys (key_hash, first_seen_at) VALUES ($hash, $at)",
    );
    const insertItem = db.prepare(
      `INSERT INTO items (source_id, key_hash, revision_id, envelope, kek_version, created_at)
       VALUES ($source, $hash, $rev, $envelope, 1, $at)`,
    );

    for (const item of items) {
      const keyHash = hashKeyName(dek, item.key);
      insertKey.run({ hash: keyHash, at });
      insertItem.run({
        source: item.sourceId,
        hash: keyHash,
        rev: revisionId,
        // The name travels inside the envelope: the column holds only its HMAC.
        envelope: seal({
          kek: dek,
          kekVersion: 1,
          plaintext: encoder.encode(`${item.key}=${item.value}`),
          context: itemContext(item.sourceId, keyHash, revisionId),
        }),
        at,
      });
    }

    if (options.movePointer !== false) {
      db.prepare(
        `INSERT INTO pointer (id, revision_id, updated_at) VALUES (1, $rev, $at)
         ON CONFLICT (id) DO UPDATE SET revision_id = $rev, updated_at = $at`,
      ).run({ rev: revisionId, at });
    }
    audit(db, "release.write", revisionId, `${items.length} items`, clock);
  });

  return { revisionId, count: items.length };
}

export function movePointer(
  db: Database,
  revisionId: string,
  clock: Clock = systemClock,
): void {
  const known = db
    .prepare<{ n: number }>(
      "SELECT count(*) AS n FROM releases WHERE revision_id = $rev",
    )
    .get({ rev: revisionId });
  if ((known?.n ?? 0) === 0) {
    throw new Error(`no release ${revisionId} in this catalog`);
  }
  const at = clock.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO pointer (id, revision_id, updated_at) VALUES (1, $rev, $at)
       ON CONFLICT (id) DO UPDATE SET revision_id = $rev, updated_at = $at`,
    ).run({ rev: revisionId, at });
    audit(db, "pointer.move", revisionId, undefined, clock);
  });
}
