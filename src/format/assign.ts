import { parseEnv, toRecord } from "./parse.js";

/**
 * One key's value changed in an env document, everything else kept: comments,
 * order, the other keys and an export prefix. The edit is offered only when
 * reading it back gives the new value and leaves every other key as it was.
 */

export type Assigned =
  | { readonly ok: true; readonly text: string; readonly assignments: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Only spellings every reader of an env file takes literally: compose env_file,
 * a shell that sources it and dotenv disagree on $ and on escapes inside double
 * quotes, so a value that needs double quotes is not written at all.
 */
function spellings(key: string, value: string): readonly string[] {
  const out: string[] = [];
  if (/^[\w./:@%+,=-]*$/.test(value)) out.push(`${key}=${value}`);
  if (!/['\n\r\\]/.test(value)) out.push(`${key}='${value}'`);
  return out;
}

function sameExcept(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  key: string,
): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete(key);
  for (const other of keys) if (before[other] !== after[other]) return false;
  return true;
}

function replaced(
  text: string,
  spelling: string,
  last: { line: number; endLine: number; exported?: boolean } | undefined,
): string {
  if (last === undefined) {
    const body = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}${spelling}\n`;
  }
  const lines = text.split("\n");
  const line = last.exported ? `export ${spelling}` : spelling;
  return [
    ...lines.slice(0, last.line - 1),
    line,
    ...lines.slice(last.endLine),
  ].join("\n");
}

export function assignInDocument(
  text: string,
  key: string,
  value: string,
): Assigned {
  const parsed = parseEnv(text);
  const before = toRecord(parsed);
  if (!parsed.ok || before === null)
    return { ok: false, reason: "the file is not env format" };

  const matches = parsed.entries.filter(
    (entry) => entry.kind === "assignment" && entry.key === key,
  );
  const candidates = spellings(key, value);
  if (candidates.length === 0)
    return {
      ok: false,
      reason: `the new ${key} needs quoting that the readers of an env file disagree on`,
    };

  for (const spelling of candidates) {
    const candidate = replaced(text, spelling, matches.at(-1));
    const after = toRecord(parseEnv(candidate));
    if (after === null || after[key] !== value) continue;
    if (!sameExcept(before, after, key)) continue;
    return { ok: true, text: candidate, assignments: matches.length };
  }
  return {
    ok: false,
    reason: `the edited file would not read back the same for ${key}`,
  };
}
