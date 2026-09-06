/**
 * export — the one command that prints values. Everything else in this package
 * reports keys and provenance and never a value, so this path is explicit,
 * asks for the secret rather than taking it from argv, and says what it did.
 */

import { existsSync } from "node:fs";

import type { Unlock } from "../crypto/keyring.js";
import { locateCatalogs, type LocateOptions } from "../loader/locate.js";
import { readEntries, type CatalogEntry } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";

export type ExportFormat = "csv" | "env" | "json" | "shell";

export interface ExportOptions extends LocateOptions {
  readonly unlock: Unlock;
  readonly format?: ExportFormat;
  readonly aliases?: readonly string[];
  readonly revisionId?: string;
  /** Include the machine-wide layer. Off by default: export one store at a time. */
  readonly includeGlobal?: boolean;
}

export interface ExportResult {
  readonly text: string;
  readonly count: number;
  /** Keys whose value a spreadsheet would evaluate rather than display. */
  readonly formulaKeys: readonly string[];
  readonly catalogs: readonly string[];
}

/** RFC 4180. Every field is quoted: env values carry commas and newlines. */
export function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const FORMULA_START = new Set(["=", "+", "-", "@"]);

function toCsv(entries: readonly (CatalogEntry & { layer: string })[]): string {
  const rows = [
    ["key", "value", "source", "path", "layer"].map(csvField).join(","),
  ];
  for (const entry of entries) {
    rows.push(
      [entry.key, entry.value, entry.alias, entry.path, entry.layer]
        .map(csvField)
        .join(","),
    );
  }
  return `${rows.join("\r\n")}\r\n`;
}

/** For eval $(envs export --format shell --yes), as dotenvx and doppler do. */
function toShell(entries: readonly CatalogEntry[]): string {
  return entries
    .map((entry) => `export ${entry.key}=${JSON.stringify(entry.value)}`)
    .join("\n")
    .concat("\n");
}

function toEnvFile(entries: readonly CatalogEntry[]): string {
  return entries
    .map((entry) => `${entry.key}=${JSON.stringify(entry.value)}`)
    .join("\n")
    .concat("\n");
}

function readCatalog(
  path: string,
  options: ExportOptions,
  layer: string,
): (CatalogEntry & { layer: string })[] {
  if (!existsSync(path)) return [];
  const db = openDatabaseSync(path, { readOnly: true });
  try {
    return readEntries(db, {
      unlock: options.unlock,
      ...(options.aliases ? { aliases: options.aliases } : {}),
      ...(options.revisionId ? { revisionId: options.revisionId } : {}),
    }).map((entry) => ({ ...entry, layer }));
  } finally {
    db.close();
  }
}

export function exportValues(options: ExportOptions): ExportResult {
  const located = locateCatalogs(options);
  const catalogs: string[] = [];
  const entries: (CatalogEntry & { layer: string })[] = [];

  catalogs.push(located.project);
  entries.push(...readCatalog(located.project, options, "project"));
  if (options.includeGlobal === true && located.global !== undefined) {
    catalogs.push(located.global);
    entries.push(...readCatalog(located.global, options, "global"));
  }

  const format = options.format ?? "csv";
  const text =
    format === "csv"
      ? toCsv(entries)
      : format === "env"
        ? toEnvFile(entries)
        : format === "shell"
          ? toShell(entries)
          : `${JSON.stringify(
              Object.fromEntries(entries.map((e) => [e.key, e.value])),
              null,
              2,
            )}\n`;

  return {
    text,
    count: entries.length,
    // Not rewritten: altering a value to make a spreadsheet safe would hand back
    // something that is not what is stored. The hazard is reported instead.
    formulaKeys: entries
      .filter((e) => e.value.length > 0 && FORMULA_START.has(e.value[0]!))
      .map((e) => e.key),
    catalogs,
  };
}
