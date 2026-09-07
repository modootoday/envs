/**
 * A command is a value: its name, what it takes, and what it does. Help is
 * generated from that rather than written twice, so a flag cannot exist in one
 * and not the other.
 */

import type { Ui } from "./ui.js";

export interface OptionSpec {
  readonly name: string;
  readonly describe: string;
  /** A flag with no value. */
  readonly boolean?: boolean;
  /** May appear more than once; the parsed value is always an array. */
  readonly repeat?: boolean;
  readonly placeholder?: string;
}

export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
}

export interface CommandContext {
  readonly ui: Ui;
  readonly args: ParsedArgs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

/** Help headings, in the order someone meets them. */
export const GROUPS = [
  "start here",
  "values",
  "check",
  "history",
  "backup",
  "hosted account",
  "publish",
] as const;

export type Group = (typeof GROUPS)[number];

export interface Command {
  readonly name: string;
  readonly describe: string;
  readonly usage: string;
  /** Which help heading it sits under. Absent means the trailing one. */
  readonly group?: Group;
  readonly options?: readonly OptionSpec[];
  /**
   * Exit code. 0 success, 1 the work failed, 2 the invocation was wrong.
   * May be async: a destination can be a network. config() stays synchronous,
   * which is a rule about the loader rather than about commands.
   */
  run(context: CommandContext): number | Promise<number>;
}

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

/**
 * Parses against the command's own option list, so an unknown flag is an error
 * rather than a silently ignored typo -- `--recover-code` must not look like it
 * worked.
 */
export function parseArgs(
  argv: readonly string[],
  specs: readonly OptionSpec[] = [],
): ParsedArgs {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const spec = byName.get(name);
    if (spec === undefined) {
      throw new ArgumentError(`unknown option --${name}`);
    }
    if (spec.boolean === true) {
      if (eq !== -1) {
        throw new ArgumentError(`--${name} does not take a value`);
      }
      flags.add(name);
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) {
      throw new ArgumentError(`--${name} needs a value`);
    }
    const existing = options.get(name);
    if (existing !== undefined && spec.repeat !== true) {
      throw new ArgumentError(`--${name} was given more than once`);
    }
    options.set(name, [...(existing ?? []), value]);
  }

  return { positional, options, flags };
}

export function one(args: ParsedArgs, name: string): string | undefined {
  return args.options.get(name)?.[0];
}

export function many(args: ParsedArgs, name: string): readonly string[] {
  return args.options.get(name) ?? [];
}

export function printCommandHelp(ui: Ui, command: Command): void {
  ui.heading(`envs ${command.name}`);
  ui.line(`  ${command.describe}`);
  ui.line();
  ui.line(`  ${ui.paint(command.usage, "dim")}`);
  if (command.options && command.options.length > 0) {
    ui.line();
    ui.table(
      command.options.map((option) => [
        `--${option.name}${option.placeholder ? ` ${option.placeholder}` : ""}`,
        option.describe,
      ]),
    );
  }
  ui.line();
}

export function printHelp(
  ui: Ui,
  commands: readonly Command[],
  notImplemented: readonly string[],
): void {
  ui.heading("envs — environment values in a catalog");
  ui.line();
  // Grouped by the command's own declaration rather than a second list here.
  // A command that names no group still prints, under the last heading.
  const ungrouped = commands.filter(
    (command) => command.group === undefined || !GROUPS.includes(command.group),
  );
  for (const group of GROUPS) {
    const members = commands.filter((command) => command.group === group);
    const rows =
      group === GROUPS[GROUPS.length - 1]
        ? [...members, ...ungrouped]
        : members;
    if (rows.length === 0) continue;
    ui.line(`  ${ui.paint(group, "dim")}`);
    ui.table(rows.map((command) => [command.name, command.describe]));
    ui.line();
  }
  // Omitted when the list is empty: a heading with nothing under it reads as a
  // formatting bug rather than as good news.
  if (notImplemented.length > 0) {
    ui.line(
      `  ${ui.paint(`not implemented yet: ${notImplemented.join(", ")}`, "dim")}`,
    );
    ui.line();
  }
}
