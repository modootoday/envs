/**
 * A template is a schema for keys. It never carries a value, and that is the
 * only reason a public registry of these can exist: anything that can hold a
 * value eventually holds a real one.
 */

import { sha256Hex } from "../crypto/digest.js";

export type Sensitivity = "secret" | "config";

export interface TemplateKey {
  readonly required: boolean;
  readonly sensitivity: Sensitivity;
  readonly pattern?: string;
  readonly obtain?: string;
  readonly rotateDays?: number;
  readonly description?: string;
}

export interface Template {
  readonly name: string;
  readonly version: number;
  readonly title: string;
  readonly keys: Readonly<Record<string, TemplateKey>>;
}

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly at?: string,
  ) {
    super(at === undefined ? message : `${at}: ${message}`);
    this.name = "TemplateError";
  }
}

/** Exactly the fields §3.1 names. A tolerant parser is how a value field
 * arrives later without anyone deciding to add one. */
const TEMPLATE_FIELDS = new Set(["name", "version", "title", "keys"]);
const KEY_FIELDS = new Set([
  "required",
  "sensitivity",
  "pattern",
  "obtain",
  "rotateDays",
  "description",
]);

const NAME = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]\/[a-z0-9][a-z0-9-]{0,38}$/;
const KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A pattern is compiled here, so a template that cannot be checked is
 * rejected at parse rather than at the moment someone relies on it. */
const PATTERN_MAX = 200;
/**
 * A quantified group whose body is itself quantified -- (a+)+ and its
 * relatives. Refused by shape rather than timed, because a timing test
 * passes on a fast machine and fails on a loaded one.
 */
const NESTED_QUANTIFIER = /\([^()]*[+*}][^()]*\)(?:[+*]|\{\d+,\})/;

function ownFields(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TemplateError("must be an object", at);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  fields: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  at: string,
): void {
  for (const name of Object.keys(fields)) {
    if (!allowed.has(name)) {
      throw new TemplateError(`unknown field "${name}"`, at);
    }
  }
}

export function compilePattern(pattern: string, at: string): RegExp {
  if (pattern.length > PATTERN_MAX) {
    throw new TemplateError(
      `pattern is longer than ${String(PATTERN_MAX)} characters`,
      at,
    );
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    throw new TemplateError("pattern nests quantifiers and may not halt", at);
  }
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    // Unanchored, "sk_live_x" matches inside anything, so the check that was
    // meant to catch a swapped key passes on the swapped key.
    throw new TemplateError("pattern must be anchored with ^ and $", at);
  }
  try {
    return new RegExp(pattern, "u");
  } catch {
    throw new TemplateError("pattern is not a valid regular expression", at);
  }
}

function parseKey(
  raw: unknown,
  at: string,
  allowObtain: (url: string, at: string) => void,
): TemplateKey {
  const fields = ownFields(raw, at);
  rejectUnknown(fields, KEY_FIELDS, at);

  const required = fields["required"];
  if (typeof required !== "boolean") {
    throw new TemplateError("required must be true or false", at);
  }
  const sensitivity = fields["sensitivity"];
  if (sensitivity !== "secret" && sensitivity !== "config") {
    throw new TemplateError('sensitivity must be "secret" or "config"', at);
  }

  const key: {
    required: boolean;
    sensitivity: Sensitivity;
    pattern?: string;
    obtain?: string;
    rotateDays?: number;
    description?: string;
  } = { required, sensitivity };

  const pattern = fields["pattern"];
  if (pattern !== undefined) {
    if (typeof pattern !== "string") {
      throw new TemplateError("pattern must be a string", at);
    }
    compilePattern(pattern, at);
    key.pattern = pattern;
  }

  const obtain = fields["obtain"];
  if (obtain !== undefined) {
    if (typeof obtain !== "string") {
      throw new TemplateError("obtain must be a string", at);
    }
    allowObtain(obtain, at);
    key.obtain = obtain;
  }

  const rotateDays = fields["rotateDays"];
  if (rotateDays !== undefined) {
    if (
      typeof rotateDays !== "number" ||
      !Number.isInteger(rotateDays) ||
      rotateDays <= 0 ||
      rotateDays > 3650
    ) {
      throw new TemplateError("rotateDays must be a whole number of days", at);
    }
    key.rotateDays = rotateDays;
  }

  const description = fields["description"];
  if (description !== undefined) {
    if (typeof description !== "string" || description.length > 300) {
      throw new TemplateError("description must be a short string", at);
    }
    key.description = description;
  }

  return key;
}

export interface ParseOptions {
  /** Checks an obtain URL. Injected because the allowlist belongs to the
   * registry, and both it and lint must use the same one. */
  readonly allowObtain?: (url: string, at: string) => void;
}

/**
 * Parses the bytes, not a parsed object: a duplicate key is invisible after
 * JSON.parse, and the last one silently wins.
 */
export function parseTemplate(text: string, options: ParseOptions = {}): Template {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TemplateError("is not valid JSON");
  }
  assertNoDuplicateKeys(text);

  const fields = ownFields(raw, "template");
  rejectUnknown(fields, TEMPLATE_FIELDS, "template");

  const name = fields["name"];
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new TemplateError(
      'name must be "publisher/template" in lowercase',
      "template",
    );
  }
  const version = fields["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new TemplateError("version must be a whole number from 1", "template");
  }
  const title = fields["title"];
  if (typeof title !== "string" || title === "" || title.length > 120) {
    throw new TemplateError("title must be a short non-empty string", "template");
  }

  const keys = ownFields(fields["keys"], "keys");
  const names = Object.keys(keys);
  if (names.length === 0) {
    throw new TemplateError("must declare at least one key", "keys");
  }
  if (names.length > 100) {
    throw new TemplateError("declares more than 100 keys", "keys");
  }

  const allowObtain = options.allowObtain ?? (() => undefined);
  const parsed: Record<string, TemplateKey> = {};
  for (const keyName of names) {
    if (!KEY_NAME.test(keyName)) {
      throw new TemplateError(
        "key names are upper snake case",
        `keys.${keyName}`,
      );
    }
    parsed[keyName] = parseKey(keys[keyName], `keys.${keyName}`, allowObtain);
  }

  return { name, version, title, keys: parsed };
}

/**
 * JSON.parse merges duplicates before anything can see them, so the bytes are
 * scanned separately. The same rule the contract gate applies to manifests.
 */
export function assertNoDuplicateKeys(text: string): void {
  const seen: Set<string>[] = [];
  let depth = -1;
  let index = 0;
  let inString = false;
  let escaped = false;
  let current = "";
  let captured: string | null = null;

  while (index < text.length) {
    const ch = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        captured = current;
      } else current += ch;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current = "";
      captured = null;
    } else if (ch === "{") {
      depth += 1;
      seen[depth] = new Set();
    } else if (ch === "}") {
      if (depth >= 0) depth -= 1;
    } else if (ch === ":" && captured !== null && depth >= 0) {
      const scope = seen[depth]!;
      if (scope.has(captured)) {
        throw new TemplateError(`duplicate field "${captured}"`);
      }
      scope.add(captured);
      captured = null;
    } else if (ch === "," || ch === "[") {
      captured = null;
    }
    index += 1;
  }
}

/** The digest a catalog records, so a template that changed later is visible.
 * Computed over the bytes as published, not over a re-serialisation. */
export async function templateDigest(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}
