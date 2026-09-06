/**
 * config(), shaped like dotenv's and resolving a store rather than a file. Fully
 * synchronous: this is a side-effect import, so nothing here may await.
 */

import { existsSync, readFileSync } from "node:fs";

import { parseEnv, toRecord } from "../format/parse.js";
import type { Unlock } from "../crypto/keyring.js";
import { openDatabaseSync, type Database } from "../sqlite/open.js";
import { locateCatalogs, type LocateOptions } from "./locate.js";
import { readEntries, type CatalogEntry } from "./read.js";

export type OnConflict = "ignore" | "warn" | "throw";

/**
 * Node's BufferEncoding, restated. The published declarations must not need an
 * ambient global a consumer may not have loaded.
 */
export type Encoding =
  | "ascii"
  | "utf8"
  | "utf-8"
  | "utf16le"
  | "utf-16le"
  | "ucs2"
  | "ucs-2"
  | "base64"
  | "base64url"
  | "latin1"
  | "binary"
  | "hex";

export type Layer = "process" | "project" | "global" | "file";

export interface Provenance {
  readonly key: string;
  readonly layer: Layer;
  /** Alias for a catalog source, absolute path for a file. */
  readonly from: string;
}

export interface ConfigOptions {
  // dotenv's surface, kept name for name.
  readonly path?: string | readonly string[];
  readonly encoding?: Encoding;
  readonly debug?: boolean;
  readonly override?: boolean;
  readonly quiet?: boolean;
  readonly processEnv?: Record<string, string | undefined>;

  // Additions.
  /** Source aliases to load, in precedence order. */
  readonly aliases?: readonly string[];
  readonly onConflict?: OnConflict;
  /** Read the machine-wide layer. CI should turn this off. */
  readonly global?: boolean;
  readonly unlock?: Unlock;
  readonly cwd?: string;
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ConfigResult {
  readonly parsed?: Record<string, string>;
  readonly error?: Error;
  /** Where each key came from. `doctor` prints this; values are never in it. */
  readonly provenance?: readonly Provenance[];
}

export class ConflictError extends Error {
  constructor(
    readonly key: string,
    readonly first: Provenance,
    readonly second: Provenance,
  ) {
    super(
      `key "${key}" is declared by ${first.layer}:${first.from} and ${second.layer}:${second.from}`,
    );
    this.name = "ConflictError";
  }
}

export class KekMissingError extends Error {
  constructor() {
    super(
      "no key available: set ENVS_KEK, or pass unlock explicitly. Values stay sealed without it.",
    );
    this.name = "KekMissingError";
  }
}

function decodeKek(raw: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(raw, "base64"));
  if (bytes.length !== 32) {
    throw new KekMissingError();
  }
  return bytes;
}

function resolveUnlock(
  options: ConfigOptions,
  env: Readonly<Record<string, string | undefined>>,
): Unlock {
  if (options.unlock !== undefined) return options.unlock;
  const raw = env["ENVS_KEK"];
  if (raw === undefined || raw === "") throw new KekMissingError();
  return { kek: decodeKek(raw) };
}

function isTruthy(value: string | undefined): boolean {
  return (
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  );
}

function fileEntries(
  paths: readonly string[],
  encoding: Encoding,
): { entries: CatalogEntry[]; error?: Error } {
  const entries: CatalogEntry[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const parsed = parseEnv(readFileSync(path, encoding));
    const record = toRecord(parsed);
    if (record === null) {
      return {
        entries,
        error: new Error(
          `${path} is not env format: ${parsed.findings
            .map((f) => `${f.code} at line ${f.line}`)
            .join(", ")}`,
        ),
      };
    }
    for (const [key, value] of Object.entries(record)) {
      entries.push({ key, value, sourceId: path, alias: path, path });
    }
  }
  return { entries };
}

function catalogEntries(
  path: string,
  options: ConfigOptions,
  unlock: Unlock,
): readonly CatalogEntry[] {
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    db = openDatabaseSync(path, { readOnly: true });
    return readEntries(db, {
      unlock,
      ...(options.aliases ? { aliases: options.aliases } : {}),
    });
  } finally {
    db?.close();
  }
}

/**
 * dotenv's rule: the first declaration wins unless override is set, in which
 * case the last does. Layers are ordered before this runs, so the same rule
 * covers both files and the store.
 */
function merge(
  ordered: readonly { entry: CatalogEntry; layer: Layer }[],
  override: boolean,
  onConflict: OnConflict,
  debug: (message: string) => void,
): { parsed: Record<string, string>; provenance: Provenance[] } {
  const parsed: Record<string, string> = {};
  const seen = new Map<string, Provenance>();

  for (const { entry, layer } of ordered) {
    const here: Provenance = { key: entry.key, layer, from: entry.alias };
    const earlier = seen.get(entry.key);
    if (earlier === undefined) {
      parsed[entry.key] = entry.value;
      seen.set(entry.key, here);
      continue;
    }
    if (onConflict === "throw")
      throw new ConflictError(entry.key, earlier, here);
    if (onConflict === "warn") {
      debug(
        `[envs] "${entry.key}" declared by ${earlier.layer}:${earlier.from} and ${here.layer}:${here.from}`,
      );
    }
    if (override) {
      parsed[entry.key] = entry.value;
      seen.set(entry.key, here);
    }
  }

  return { parsed, provenance: [...seen.values()] };
}

export function config(options: ConfigOptions = {}): ConfigResult {
  const env = options.env ?? process.env;
  const target = options.processEnv ?? process.env;
  const override = options.override ?? false;
  const onConflict = options.onConflict ?? "ignore";
  const quiet = options.quiet ?? false;
  const debugOn = options.debug ?? false;
  const debug = (message: string): void => {
    if (debugOn || !quiet) process.stderr.write(`${message}\n`);
  };

  try {
    const locateOptions: LocateOptions = {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.home ? { home: options.home } : {}),
      env,
    };
    const located = locateCatalogs(locateOptions);
    const useGlobal =
      (options.global ?? true) && !isTruthy(env["ENVS_NO_GLOBAL"]);

    const ordered: { entry: CatalogEntry; layer: Layer }[] = [];

    if (options.path !== undefined) {
      const paths =
        typeof options.path === "string" ? [options.path] : options.path;
      const read = fileEntries(paths, options.encoding ?? "utf8");
      if (read.error) return { error: read.error };
      for (const entry of read.entries) ordered.push({ entry, layer: "file" });
    }

    const unlock = resolveUnlock(options, env);

    for (const entry of catalogEntries(located.project, options, unlock)) {
      ordered.push({ entry, layer: "project" });
    }
    if (useGlobal && located.global !== undefined) {
      for (const entry of catalogEntries(located.global, options, unlock)) {
        ordered.push({ entry, layer: "global" });
      }
    }

    // Not the same as a catalog with nothing in it: silently returning {}
    // here is how a deleted or unreachable store passes for an empty one.
    const sawCatalog =
      existsSync(located.project) ||
      (useGlobal && located.global !== undefined && existsSync(located.global));
    if (!sawCatalog && options.path === undefined) {
      return {
        error: new Error(
          `no catalog at ${located.project}; run "envs init" first`,
        ),
      };
    }

    const { parsed, provenance } = merge(ordered, override, onConflict, debug);

    // process.env wins unless override, matching dotenv, so a value already in
    // the environment is not replaced by the store.
    const applied: Provenance[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      const present = Object.prototype.hasOwnProperty.call(target, key);
      if (present && !override) {
        applied.push({ key, layer: "process", from: "process.env" });
        continue;
      }
      target[key] = value;
      applied.push(provenance.find((p) => p.key === key)!);
    }

    return { parsed, provenance: applied };
  } catch (error) {
    return { error: error as Error };
  }
}
