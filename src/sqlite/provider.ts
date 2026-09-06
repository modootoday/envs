/**
 * One provider per sqlite backend. Everything the backends disagree about lives
 * here as data, so the open path stays the same for all three.
 */

export type SqliteBackend = "bun" | "node" | "better-sqlite3";

export interface SqliteProvider {
  readonly backend: SqliteBackend;
  /** Held as a string: a literal specifier would make bundlers hard-fail. */
  readonly specifier: string;
  /** Export holding the constructor; "default" for the CJS module. */
  readonly exportName: string;
  /** Built into its runtime, so it costs a consumer nothing. */
  readonly builtIn: boolean;
  /**
   * Whether this provider may even be attempted here. Not every bad import
   * throws: loading better-sqlite3 under bun 1.3.14 panics the process with
   * NAPI FATAL ERROR, which no try/catch can contain. Ineligible providers are
   * skipped rather than tried.
   */
  eligible(): boolean;
  /** Constructor options. No two backends spell these the same way. */
  openOptions(readOnly: boolean): unknown;
  /**
   * Key form for a named parameter. Measured: bun needs the sigil token,
   * better-sqlite3 needs the bare name, node takes either. Getting it wrong is
   * not always an error — bun binds NULL and says nothing.
   */
  bindKey(bare: string, token: string): string;
}

const onBun = (): boolean =>
  typeof (globalThis as Record<string, unknown>)["Bun"] !== "undefined";

export const PROVIDERS: readonly SqliteProvider[] = [
  {
    backend: "bun",
    specifier: "bun:sqlite",
    exportName: "Database",
    builtIn: true,
    // Rejects {} and {readonly:false}; a writable handle needs create.
    openOptions: (readOnly) =>
      readOnly ? { readonly: true } : { readonly: false, create: true },
    eligible: onBun,
    bindKey: (_bare, token) => token,
  },
  {
    backend: "node",
    specifier: "node:sqlite",
    exportName: "DatabaseSync",
    builtIn: true,
    // Spells it readOnly and silently ignores the lowercase name, which would
    // hand back a writable database.
    openOptions: (readOnly) => ({ readOnly }),
    eligible: () => !onBun(),
    bindKey: (_bare, token) => token,
  },
  {
    backend: "better-sqlite3",
    specifier: "better-sqlite3",
    exportName: "default",
    builtIn: false,
    // Wants the lowercase name and rejects the other as a misspelling.
    openOptions: (readOnly) => ({ readonly: readOnly }),
    // Never attempted on bun: the load is a process panic, not an exception.
    eligible: () => !onBun(),
    bindKey: (bare) => bare,
  },
];

export function providerFor(backend: string): SqliteProvider | undefined {
  return PROVIDERS.find((provider) => provider.backend === backend);
}
