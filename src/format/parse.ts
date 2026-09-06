/**
 * env format parser. An env document is a sequence of logical entries, each a
 * comment, a blank line, or KEY=VALUE; a fourth kind means the file is not env
 * format and none of it loads. Values never appear in findings.
 */

export type EntryKind = "comment" | "blank" | "assignment";

export type Quote = '"' | "'" | "`";

export interface ParsedEntry {
  readonly kind: EntryKind;
  /** 1-based line where the entry starts. */
  readonly line: number;
  /** 1-based line where the entry ends; differs from line for multiline values. */
  readonly endLine: number;
  readonly key?: string;
  readonly value?: string;
  readonly quote?: Quote | null;
  /** `export KEY=v` form. */
  readonly exported?: boolean;
}

export type FindingCode =
  | "NOT_ENV_LINE"
  | "EMPTY_KEY"
  | "INVALID_KEY"
  | "UNTERMINATED_QUOTE"
  | "TRAILING_CONTENT";

export interface ParseFinding {
  readonly code: FindingCode;
  readonly line: number;
}

export interface ParseResult {
  readonly ok: boolean;
  readonly entries: readonly ParsedEntry[];
  readonly findings: readonly ParseFinding[];
}

/** dotenv's key charset. Case is not constrained: `api_key=v` is env format. */
const KEY_PATTERN = /^[\w.-]+$/;

const EXPORT_PREFIX = /^export\s+/;

/**
 * Only \n and \r expand, measured against dotenv 17.4.2. Every other backslash
 * stays literal so Windows paths survive.
 */
function expandDoubleQuoted(raw: string): string {
  return raw.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

function isQuote(ch: string): ch is Quote {
  return ch === '"' || ch === "'" || ch === "`";
}

interface ValueScan {
  readonly value: string;
  readonly quote: Quote | null;
  /** Index just past the value, within the normalised text. */
  readonly next: number;
  readonly unterminated: boolean;
}

function scanQuoted(text: string, start: number, quote: Quote): ValueScan {
  let i = start + 1;
  let out = "";
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) {
      out += ch + text[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === quote) {
      return {
        value: quote === '"' ? expandDoubleQuoted(out) : out,
        quote,
        next: i + 1,
        unterminated: false,
      };
    }
    out += ch;
    i += 1;
  }
  return { value: out, quote, next: text.length, unterminated: true };
}

function scanBare(text: string, start: number): ValueScan {
  let i = start;
  while (i < text.length && text[i] !== "\n" && text[i] !== "#") i += 1;
  return {
    value: text.slice(start, i).trim(),
    quote: null,
    next: i,
    unterminated: false,
  };
}

function countLines(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i += 1) if (text[i] === "\n") n += 1;
  return n;
}

/** Whatever follows a value on its line must be blank or a comment. */
function restOfLineIsClean(text: string, from: number): boolean {
  let i = from;
  while (i < text.length && text[i] !== "\n") {
    const ch = text[i]!;
    if (ch === "#") return true;
    if (ch !== " " && ch !== "\t") return false;
    i += 1;
  }
  return true;
}

export function parseEnv(input: string): ParseResult {
  const text = input.replace(/\r\n?/g, "\n");
  const entries: ParsedEntry[] = [];
  const findings: ParseFinding[] = [];

  let i = 0;
  let line = 1;

  const skipToNextLine = (from: number): number => {
    const nl = text.indexOf("\n", from);
    return nl === -1 ? text.length : nl + 1;
  };

  while (i < text.length) {
    const eol = text.indexOf("\n", i);
    const lineEnd = eol === -1 ? text.length : eol;
    const raw = text.slice(i, lineEnd);
    const trimmed = raw.trim();

    if (trimmed === "") {
      entries.push({ kind: "blank", line, endLine: line });
      i = lineEnd + 1;
      line += 1;
      continue;
    }

    if (trimmed.startsWith("#")) {
      entries.push({ kind: "comment", line, endLine: line });
      i = lineEnd + 1;
      line += 1;
      continue;
    }

    const lead = raw.length - raw.trimStart().length;
    const body = raw.slice(lead);
    const exported = EXPORT_PREFIX.test(body);
    const afterExport = exported ? body.replace(EXPORT_PREFIX, "") : body;
    const keyOffset = i + lead + (body.length - afterExport.length);

    const eq = afterExport.indexOf("=");
    if (eq === -1) {
      findings.push({ code: "NOT_ENV_LINE", line });
      i = lineEnd + 1;
      line += 1;
      continue;
    }

    const key = afterExport.slice(0, eq).trim();
    if (key === "") {
      findings.push({ code: "EMPTY_KEY", line });
      i = lineEnd + 1;
      line += 1;
      continue;
    }
    if (!KEY_PATTERN.test(key)) {
      findings.push({ code: "INVALID_KEY", line });
      i = lineEnd + 1;
      line += 1;
      continue;
    }

    let cursor = keyOffset + eq + 1;
    while (
      cursor < text.length &&
      (text[cursor] === " " || text[cursor] === "\t")
    ) {
      cursor += 1;
    }

    const ch = text[cursor];
    const scan =
      ch !== undefined && isQuote(ch)
        ? scanQuoted(text, cursor, ch)
        : scanBare(text, cursor);

    if (scan.unterminated) {
      findings.push({ code: "UNTERMINATED_QUOTE", line });
      i = text.length;
      break;
    }

    const endLine = line + countLines(text, i, scan.next);

    if (!restOfLineIsClean(text, scan.next)) {
      findings.push({ code: "TRAILING_CONTENT", line: endLine });
      i = skipToNextLine(scan.next);
      line = endLine + 1;
      continue;
    }

    entries.push({
      kind: "assignment",
      line,
      endLine,
      key,
      value: scan.value,
      quote: scan.quote,
      exported,
    });

    i = skipToNextLine(scan.next);
    line = endLine + 1;
  }

  return { ok: findings.length === 0, entries, findings };
}

/**
 * All-or-nothing: a file with any finding contributes no values at all, so a
 * partially parseable file cannot lose entries silently.
 */
export function toRecord(result: ParseResult): Record<string, string> | null {
  if (!result.ok) return null;
  const out: Record<string, string> = {};
  for (const entry of result.entries) {
    if (entry.kind === "assignment") out[entry.key!] = entry.value!;
  }
  return out;
}
