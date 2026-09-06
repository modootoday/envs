import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { BackupError, providers, resolveProvider } from "../backup/provider.js";
import "../backup/providers.js";
import "../backup/remote.js";
import { pack, readHeader, snapshotName, unpack } from "../backup/snapshot.js";
import { readMeta } from "../catalog/schema.js";
import { audit } from "../catalog/write.js";
import { one, type Command } from "../cli/command.js";
import { unlockDek } from "../crypto/keyring.js";
import { locateCatalogs } from "../loader/locate.js";
import { readWraps } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import { resolveUnlock } from "./unlock.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * --to is one destination spelled for one run. A scheme picks the provider,
 * because "s3://bucket" read as a directory name would quietly write a folder
 * called s3: next to the catalog.
 */
export function destinationEnv(env: Env, to: string | undefined): Env {
  if (to === undefined) return env;
  const remote = /^envs:\/\/(.*)$/.exec(to);
  if (remote) {
    const scope = remote[1]!.replace(/^\/+|\/+$/g, "");
    return {
      ...env,
      ENVS_BACKUP_PROVIDER: "envs",
      ...(scope === "" ? {} : { ENVS_REMOTE_SCOPE: scope }),
    };
  }
  const s3 = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(to);
  if (s3) {
    const prefix = (s3[2] ?? "").replace(/^\/+|\/+$/g, "");
    return {
      ...env,
      ENVS_BACKUP_PROVIDER: "s3",
      ENVS_BACKUP_BUCKET: s3[1]!,
      ...(prefix === "" ? {} : { ENVS_BACKUP_PREFIX: prefix }),
    };
  }
  return { ...env, ENVS_BACKUP_DIR: to, ENVS_BACKUP_PROVIDER: "file" };
}

const DESTINATION_OPTIONS = [
  {
    name: "to",
    placeholder: "<dest>",
    describe: "a directory, s3://bucket/prefix, or envs:// for your account",
  },
  {
    name: "provider",
    placeholder: "<name>",
    describe: "file, s3 or envs; otherwise the first that is configured",
  },
  {
    name: "recovery-code",
    placeholder: "<code|->",
    describe: "unlock with a recovery code; - reads it from stdin",
  },
] as const;

export const backupCommand: Command = {
  name: "backup",
  describe: "write an encrypted snapshot of the catalog",
  usage: "envs backup [--to <dest>] [--provider file|s3|envs]",
  options: [...DESTINATION_OPTIONS],

  async run({ ui, args, env, cwd }) {
    const located = locateCatalogs({ cwd, env });
    if (!existsSync(located.project)) {
      ui.error("no catalog here", located.project);
      return 1;
    }
    const unlock = resolveUnlock(one(args, "recovery-code"), env);
    if (typeof unlock === "string") {
      ui.error(unlock);
      return 2;
    }

    try {
      const destination = destinationEnv(env, one(args, "to"));
      const provider = resolveProvider(destination, one(args, "provider"));

      const db = openDatabaseSync(located.project);
      let blob: Uint8Array;
      let name: string;
      try {
        // Everything in the WAL has to reach the main file first, or the
        // snapshot is of a database missing its most recent writes.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const meta = readMeta(db);
        if (meta === undefined) throw new BackupError("catalog has no schema");
        const wraps = readWraps(db);
        const dek = unlockDek(wraps, unlock);
        const createdAt = new Date().toISOString();
        blob = pack({
          catalogBytes: new Uint8Array(readFileSync(located.project)),
          catalogId: meta.catalogId,
          schemaVersion: meta.version,
          wraps,
          dek,
          createdAt,
        });
        name = snapshotName(meta.catalogId, createdAt);
        audit(db, "backup.write", name, provider.name);
      } finally {
        // Closed before the upload: a slow destination must not hold the lock.
        db.close();
      }

      await provider.put(destination, name, blob);
      ui.success(`wrote ${name}`, `${blob.length} bytes`);
      ui.info(provider.describe(destination));
      return 0;
    } catch (error) {
      ui.error((error as Error).message);
      return 1;
    }
  },
};

export const restoreCommand: Command = {
  name: "restore",
  describe: "put a snapshot back, keeping the catalog it replaces",
  usage: "envs restore <name> [--to <dest>] [--force]  |  envs restore --list",
  options: [
    ...DESTINATION_OPTIONS,
    {
      name: "list",
      boolean: true,
      describe: "list what the destination holds",
    },
    {
      name: "force",
      boolean: true,
      describe: "replace an existing catalog (the old one is kept beside it)",
    },
  ],

  async run({ ui, args, env, cwd }) {
    const destination = destinationEnv(env, one(args, "to"));
    let provider;
    try {
      provider = resolveProvider(destination, one(args, "provider"));
    } catch (error) {
      ui.error((error as Error).message);
      ui.table(
        providers().map((candidate) => [
          candidate.name,
          candidate.eligible(destination)
            ? candidate.describe(destination)
            : `not configured — ${candidate.describe(destination)}`,
        ]),
      );
      return 2;
    }

    if (args.flags.has("list")) {
      try {
        const found = await provider.list(destination);
        if (found.length === 0) {
          ui.info("nothing there", provider.describe(destination));
          return 0;
        }
        ui.heading(provider.describe(destination));
        ui.table(
          found.map((snapshot) => [
            snapshot.name,
            `${snapshot.size} bytes  ${snapshot.modifiedAt ?? ""}`.trimEnd(),
          ]),
        );
        return 0;
      } catch (error) {
        ui.error((error as Error).message);
        return 1;
      }
    }

    const name = args.positional[0];
    if (name === undefined || args.positional.length > 1) {
      ui.error("give one snapshot name", "envs restore --list shows them");
      return 2;
    }
    // A recovery code is enough on purpose: the key may be exactly what was
    // lost, and a backup that needs it would be no backup at all.
    const unlock = resolveUnlock(one(args, "recovery-code"), env);
    if (typeof unlock === "string") {
      ui.error(unlock, "a recovery code is enough here");
      return 2;
    }

    const located = locateCatalogs({ cwd, env });
    if (existsSync(located.project) && !args.flags.has("force")) {
      ui.error("a catalog is already here", located.project);
      ui.info("pass --force", "the one it replaces is kept beside it");
      return 1;
    }

    try {
      const blob = await provider.get(destination, name);
      const { header, catalogBytes } = unpack(blob, unlock);
      mkdirSync(dirname(located.project), { recursive: true });
      if (existsSync(located.project)) {
        // Never overwritten in place: restoring the wrong snapshot must be
        // undoable.
        const kept = `${located.project}.replaced-${Date.now()}`;
        copyFileSync(located.project, kept);
        ui.info("kept the catalog it replaced", kept);
      }
      const incoming = `${located.project}.incoming`;
      writeFileSync(incoming, catalogBytes, { mode: 0o600 });
      renameSync(incoming, located.project);
      // The sidecars belong to the database being replaced. Left in place,
      // sqlite replays that journal onto the restored file and the values the
      // snapshot was taken to undo come straight back. Measured on bun, where
      // the write had not been checkpointed.
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(`${located.project}${suffix}`, { force: true });
      }
      ui.success(`restored ${name}`, `catalog ${header.catalogId.slice(0, 8)}`);
      ui.info("taken at", header.createdAt);
      ui.info("schema", String(header.schemaVersion));
      return 0;
    } catch (error) {
      ui.error((error as Error).message);
      return 1;
    }
  },
};

/** A snapshot's header reads without a key, which is what makes a listing useful. */
export function describeSnapshot(bytes: Uint8Array): string {
  const { header } = readHeader(bytes);
  return `${header.catalogId.slice(0, 8)} taken ${header.createdAt}, ${header.wraps.length} ways in`;
}
