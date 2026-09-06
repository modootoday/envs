/**
 * Aliases name a source. They are module subpath and identifier material, not
 * display strings, and once assigned they never change: a script that says
 * --source main must not come to mean a different file.
 */

import { basename, dirname, sep } from "node:path";

export class AliasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AliasError";
  }
}

/**
 * Leading dots go, dots become dashes, and the result is lower case in a narrow
 * charset. A default alias of ".env" is usable as neither a subpath nor an
 * identifier, and mixed case would make two aliases one file on a
 * case-insensitive filesystem.
 */
export function normaliseAlias(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/\./g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned === "") {
    throw new AliasError(`"${raw}" normalises to nothing; give an alias`);
  }
  return cleaned;
}

/** The underscore marks a counter, so it cannot be confused with a path part. */
const OFFSET = "_";

export interface DeriveOptions {
  /** Aliases already in use, including retired ones. */
  readonly taken: ReadonlySet<string>;
  /** How far up the path qualification may reach before falling back. */
  readonly maxSegments?: number;
}

/**
 * Filename first, then the smallest amount of parent path that distinguishes
 * it, then a counter. The middle step exists because measurement found seven
 * tracked env files in this workspace sharing the basename .env.example: with
 * only the counter, six of them get names nobody can act on.
 */
export function deriveAlias(path: string, options: DeriveOptions): string {
  const { taken } = options;
  const maxSegments = options.maxSegments ?? 4;

  const base = normaliseAlias(basename(path));
  if (!taken.has(base)) return base;

  const parents = dirname(path)
    .split(sep)
    .filter((segment) => segment !== "" && segment !== ".");
  for (
    let depth = 1;
    depth <= Math.min(maxSegments, parents.length);
    depth += 1
  ) {
    const prefix = parents
      .slice(parents.length - depth)
      .map((segment) => normaliseAlias(segment))
      .join("-");
    const candidate = `${prefix}-${base}`;
    if (!taken.has(candidate)) return candidate;
  }

  for (let n = 1; ; n += 1) {
    const candidate = `${base}${OFFSET}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Rejects what would not work as a subpath or an identifier. */
export function checkAlias(alias: string, taken: ReadonlySet<string>): void {
  if (!/^[a-z0-9][a-z0-9-]*(_[0-9]+)?$/.test(alias)) {
    throw new AliasError(
      `"${alias}" is not a usable alias: lower case letters, digits and dashes`,
    );
  }
  if (taken.has(alias)) {
    throw new AliasError(`alias "${alias}" is already in use or retired`);
  }
}
