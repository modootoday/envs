/**
 * One sqlite surface over three providers. Each built-in resolves only in its
 * own runtime, so an import failure is the ordinary path, and better-sqlite3 is
 * the fallback for runtimes that have neither.
 */

import { createRequire } from "node:module";

import {
  PROVIDERS,
  providerFor,
  type SqliteBackend,
  type SqliteProvider,
} from "./provider.js";

export type { SqliteBackend, SqliteProvider };
export { PROVIDERS } from "./provider.js";

export type SqliteValue = null | number | bigint | string | Uint8Array;

export type BindValue = SqliteValue | boolean;

export type BindParams =
  readonly BindValue[] | Readonly<Record<string, BindValue>>;

export interface RunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface Statement<Row = Record<string, SqliteValue>> {
  get(params?: BindParams): Row | undefined;
  all(params?: BindParams): Row[];
  run(params?: BindParams): RunResult;
}

export interface Database {
  readonly backend: SqliteBackend;
  exec(sql: string): void;
  prepare<Row = Record<string, SqliteValue>>(sql: string): Statement<Row>;
  /** BEGIN/COMMIT around fn, ROLLBACK if it throws. Not nestable. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenOptions {
  /** WAL unless the database is in memory, where it is not available. */
  readonly journalMode?: "WAL" | "DELETE" | "MEMORY";
  readonly readOnly?: boolean;
  /** Pin a backend instead of taking the first that loads. */
  readonly backend?: SqliteBackend;
}

export class SqliteUnavailableError extends Error {
  constructor(readonly attempts: ReadonlyArray<readonly [string, string]>) {
    super(
      `no sqlite backend available; tried ${attempts
        .map(([spec, reason]) => `${spec} (${reason})`)
        .join(
          ", ",
        )}. On a runtime without node:sqlite, install better-sqlite3.`,
    );
    this.name = "SqliteUnavailableError";
  }
}

export class SqliteBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteBindError";
  }
}

interface RawStatement {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): RunResult;
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

type RawConstructor = new (path: string, options?: unknown) => RawDatabase;

interface Binding {
  readonly provider: SqliteProvider;
  readonly ctor: RawConstructor;
}

/** Written without an escape so the byte cannot end up in this source file. */
const NUL = String.fromCharCode(0);

const bindings = new Map<SqliteBackend, Binding>();

/**
 * The specifier is a variable on purpose. A literal makes TypeScript resolve
 * bun:sqlite, which it cannot without bun's types, and makes bundlers treat the
 * module absent from this runtime as a hard failure.
 */
async function importModule(
  specifier: string,
): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ specifier)) as Record<
    string,
    unknown
  >;
}

function readEnv(name: string): string | undefined {
  return (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.[name];
}

/**
 * Built-ins first; a pin narrows to one. Without the pin the built-ins always
 * win and the fallback would never run anywhere it could be tested.
 */
function shortlist(
  pinned: SqliteBackend | undefined,
): readonly SqliteProvider[] {
  const name = pinned ?? readEnv("ENVS_SQLITE_BACKEND");
  if (name === undefined || name === "") return PROVIDERS;
  const provider = providerFor(name);
  if (provider === undefined) {
    throw new SqliteUnavailableError([
      [
        "backend pin",
        `"${name}" is not one of ${PROVIDERS.map((p) => p.backend).join(", ")}`,
      ],
    ]);
  }
  return [provider];
}

async function loadBinding(
  pinned: SqliteBackend | undefined,
): Promise<Binding> {
  const attempts: Array<readonly [string, string]> = [];

  for (const provider of shortlist(pinned)) {
    if (!provider.eligible()) {
      attempts.push([provider.specifier, "not eligible in this runtime"]);
      continue;
    }
    const already = bindings.get(provider.backend);
    if (already) return already;
    try {
      const mod = await importModule(provider.specifier);
      const ctor = mod[provider.exportName];
      if (typeof ctor !== "function") {
        attempts.push([provider.specifier, `no ${provider.exportName} export`]);
        continue;
      }
      const binding = { provider, ctor: ctor as RawConstructor };
      bindings.set(provider.backend, binding);
      return binding;
    } catch (error) {
      attempts.push([provider.specifier, (error as Error).message]);
    }
  }

  throw new SqliteUnavailableError(attempts);
}

/**
 * node and better-sqlite3 throw on a bound boolean and bun accepts it, so the
 * same statement would work for whoever wrote it and break for the next person.
 * undefined is refused rather than quietly stored as NULL.
 */
function normalise(value: BindValue, where: string): SqliteValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) {
    throw new SqliteBindError(
      `undefined bound at ${where}; pass null to mean NULL`,
    );
  }
  // Measured: sqlite TEXT ends at the first NUL, so "a\0b" is stored and read
  // back as "a". Env values are arbitrary bytes from files this package does
  // not control, and losing the tail of one silently is worse than refusing.
  if (typeof value === "string" && value.includes(NUL)) {
    throw new SqliteBindError(
      `value at ${where} contains a NUL byte, which sqlite TEXT truncates; store it as bytes instead`,
    );
  }
  return value;
}

/**
 * Named placeholders in a statement, bare name to the exact token. bun binds
 * NULL without complaint when a key's sigil does not match its placeholder, so
 * keys are matched against the SQL rather than trusted or stripped.
 */
export function scanPlaceholders(sql: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      i += 1;
      while (i < sql.length && sql[i] !== ch) i += 1;
      i += 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "$" || ch === ":" || ch === "@") {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1;
      if (j > i + 1) {
        const token = sql.slice(i, j);
        found.set(token.slice(1), token);
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return found;
}

function bindArgs(
  params: BindParams | undefined,
  placeholders: ReadonlyMap<string, string>,
  provider: SqliteProvider,
): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) {
    return params.map((value, index) =>
      normalise(value, `position ${index + 1}`),
    );
  }
  const out: Record<string, SqliteValue> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(
    params as Record<string, BindValue>,
  )) {
    const bare = key.replace(/^[$:@]/, "");
    const token = placeholders.get(bare);
    if (token === undefined) {
      throw new SqliteBindError(
        `named parameter "${key}" has no placeholder in the statement`,
      );
    }
    if (seen.has(bare)) {
      throw new SqliteBindError(`named parameter "${bare}" given twice`);
    }
    seen.add(bare);
    out[provider.bindKey(bare, token)] = normalise(value, `parameter ${key}`);
  }
  for (const bare of placeholders.keys()) {
    if (!seen.has(bare)) {
      throw new SqliteBindError(`placeholder "${bare}" has no value`);
    }
  }
  return [out];
}

function wrapStatement<Row>(
  raw: RawStatement,
  sql: string,
  provider: SqliteProvider,
): Statement<Row> {
  const placeholders = scanPlaceholders(sql);
  const args = (params: BindParams | undefined): unknown[] =>
    bindArgs(params, placeholders, provider);
  return {
    // Measured: with no matching row bun returns null and node undefined, so a
    // caller's `!== undefined` check passes on one runtime and dereferences
    // null on the other. One absent value for both.
    get: (params) => (raw.get(...args(params)) ?? undefined) as Row | undefined,
    all: (params) => raw.all(...args(params)) as Row[],
    run: (params) => raw.run(...args(params)),
  };
}

const IN_MEMORY = new Set([":memory:", ""]);

/**
 * The only SQL this module would otherwise build from a string. A lookup keeps
 * it a literal: nothing a caller supplies can reach the statement text.
 */
const JOURNAL_SQL = Object.freeze({
  WAL: "PRAGMA journal_mode = WAL",
  DELETE: "PRAGMA journal_mode = DELETE",
  MEMORY: "PRAGMA journal_mode = MEMORY",
} as const);

function build(binding: Binding, path: string, options: OpenOptions): Database {
  const { provider, ctor } = binding;
  const readOnly = options.readOnly ?? false;
  const raw = new ctor(path, provider.openOptions(readOnly));

  const journalMode =
    options.journalMode ?? (IN_MEMORY.has(path) ? "MEMORY" : "WAL");
  const journalSql = JOURNAL_SQL[journalMode];
  if (journalSql === undefined) {
    throw new SqliteBindError(`unknown journal mode ${String(journalMode)}`);
  }
  if (!readOnly) raw.exec(journalSql);

  let inTransaction = false;

  return {
    backend: provider.backend,
    exec: (sql) => raw.exec(sql),
    prepare: <Row>(sql: string) =>
      wrapStatement<Row>(raw.prepare(sql), sql, provider),
    transaction<T>(fn: () => T): T {
      if (inTransaction) throw new Error("transaction() is not nestable");
      inTransaction = true;
      raw.exec("BEGIN");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close: () => raw.close(),
  };
}

export async function openDatabase(
  path: string,
  options: OpenOptions = {},
): Promise<Database> {
  return build(await loadBinding(options.backend), path, options);
}

/**
 * The module's own path, for createRequire. This file is bundled for CJS too,
 * where import.meta becomes an empty object and the call would throw on
 * undefined; __filename is the base there and is absent under ESM.
 */
function moduleBase(): string {
  return typeof __filename === "string" ? __filename : import.meta.url;
}

/**
 * Synchronous resolution, for config(), which is a side-effect import and
 * cannot await. Measured: createRequire reaches each built-in from its own
 * runtime and throws cleanly from the other, so the same shortlist applies.
 */
function loadBindingSync(pinned: SqliteBackend | undefined): Binding {
  const attempts: Array<readonly [string, string]> = [];
  const require = createRequire(moduleBase());

  for (const provider of shortlist(pinned)) {
    if (!provider.eligible()) {
      attempts.push([provider.specifier, "not eligible in this runtime"]);
      continue;
    }
    const already = bindings.get(provider.backend);
    if (already) return already;
    try {
      const mod = require(provider.specifier) as Record<string, unknown>;
      // A CJS module's whole export is the constructor; ESM names it.
      const ctor =
        provider.exportName === "default"
          ? ((mod as { default?: unknown }).default ?? mod)
          : mod[provider.exportName];
      if (typeof ctor !== "function") {
        attempts.push([provider.specifier, `no ${provider.exportName} export`]);
        continue;
      }
      const binding = { provider, ctor: ctor as RawConstructor };
      bindings.set(provider.backend, binding);
      return binding;
    } catch (error) {
      attempts.push([provider.specifier, (error as Error).message]);
    }
  }

  throw new SqliteUnavailableError(attempts);
}

export function openDatabaseSync(
  path: string,
  options: OpenOptions = {},
): Database {
  return build(loadBindingSync(options.backend), path, options);
}

/** Which backends load here. Empty when none do. */
export async function availableBackends(): Promise<readonly SqliteBackend[]> {
  const found: SqliteBackend[] = [];
  for (const provider of PROVIDERS) {
    if (!provider.eligible()) continue;
    try {
      await loadBinding(provider.backend);
      found.push(provider.backend);
    } catch {
      /* present but not loadable here */
    }
  }
  return found;
}

/** Test seam: forget loaded constructors so resolution can run again. */
export function resetBindingCache(): void {
  bindings.clear();
}
