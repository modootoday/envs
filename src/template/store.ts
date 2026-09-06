/**
 * What a catalog remembers about the templates applied to it: the name, the
 * version and the digest of the bytes. Without the digest, a registry that
 * changed quietly is a change nobody can see.
 */

import type { Database } from "../sqlite/open.js";
import { parseTemplate, type Template } from "./schema.js";

export interface TemplateRef {
  readonly name: string;
  readonly version: number;
  readonly digest: string;
  readonly appliedAt: string;
  readonly template: Template;
}

export function recordTemplate(
  db: Database,
  input: {
    readonly name: string;
    readonly version: number;
    readonly digest: string;
    readonly payload: string;
    readonly appliedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO template_ref (name, version, digest, payload, applied_at)
       VALUES ($name, $version, $digest, $payload, $appliedAt)
       ON CONFLICT (name) DO UPDATE SET
         version = $version, digest = $digest,
         payload = $payload, applied_at = $appliedAt`,
  ).run(input);
}

export function appliedTemplates(db: Database): TemplateRef[] {
  let rows: {
    name: string;
    version: number;
    digest: string;
    payload: string;
    applied_at: string;
  }[];
  try {
    rows = db
      .prepare<{
        name: string;
        version: number;
        digest: string;
        payload: string;
        applied_at: string;
      }>(
        "SELECT name, version, digest, payload, applied_at FROM template_ref ORDER BY name",
      )
      .all();
  } catch {
    // A catalog older than the table simply has none.
    return [];
  }
  const out: TemplateRef[] = [];
  for (const row of rows) {
    try {
      out.push({
        name: row.name,
        version: Number(row.version),
        digest: row.digest,
        appliedAt: row.applied_at,
        template: parseTemplate(row.payload),
      });
    } catch {
      // A payload this build cannot read is reported by doctor as an unknown
      // template rather than taking the whole command down.
      continue;
    }
  }
  return out;
}
