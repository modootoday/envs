import { spawnSync } from "node:child_process";

import { many, type Command } from "../cli/command.js";
import { config } from "../loader/config.js";
import {
  loadScopeResolver,
  ScopeProviderMissingError,
} from "../scope/provider.js";

/**
 * Without these a child cannot find its own interpreter or its home, so an
 * isolated run would fail for a reason that has nothing to do with the values.
 * Anything beyond this is named by the caller.
 */
const ALWAYS_INHERIT: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TERM",
  "LANG",
  "LC_ALL",
  "SHELL",
  "USER",
];

/**
 * The delivery method to prefer. Values reach the child through its environment
 * and never through argv, so nothing lands in a process listing, a shell
 * history or a build artifact.
 */
export const runCommand: Command = {
  name: "run",
  describe: "run a command with the values in its environment",
  usage: "envs run -- <command> [args...]",
  group: "values",
  options: [
    {
      name: "alias",
      placeholder: "<name>",
      repeat: true,
      describe: "restrict to these sources, in precedence order",
    },
    {
      name: "auto",
      boolean: true,
      describe: "take the sources from the project's declaration",
    },
    {
      name: "isolate",
      boolean: true,
      describe: "start from an empty environment rather than this one",
    },
    {
      name: "pass",
      placeholder: "<name>",
      repeat: true,
      describe: "with --isolate, let this key through from here",
    },
    {
      name: "no-global",
      boolean: true,
      describe: "leave the machine-wide layer out; CI should",
    },
    {
      name: "override",
      boolean: true,
      describe: "let the store win over values already in the environment",
    },
  ],

  async run({ ui, args, env, cwd }) {
    const [command, ...rest] = args.positional;
    if (command === undefined) {
      ui.error("no command given", "envs run -- node server.js");
      return 2;
    }

    let aliases = many(args, "alias");
    if (args.flags.has("auto")) {
      if (aliases.length > 0) {
        // Two answers to one question, and no rule says which wins.
        ui.error("--auto and --alias disagree", "pass one of them");
        return 2;
      }
      const resolved = await resolveAuto(cwd, ui);
      if (resolved === null) return 1;
      aliases = [...resolved.aliases];
      ui.info(`scope from ${resolved.from}`, aliases.join(", "));
    }

    // Isolation is opt-in: the default has always been to inherit, and a caller
    // that never asked would otherwise lose its environment on an upgrade.
    const inherited = args.flags.has("isolate")
      ? pick(env, [...ALWAYS_INHERIT, ...many(args, "pass")])
      : { ...env };
    const target: Record<string, string | undefined> = inherited;

    const result = config({
      cwd,
      env,
      processEnv: target,
      override: args.flags.has("override"),
      global: !args.flags.has("no-global"),
      ...(aliases.length > 0 ? { aliases } : {}),
    });

    if (result.error) {
      ui.error(result.error.message);
      return 1;
    }
    const count = Object.keys(result.parsed ?? {}).length;
    if (count === 0) {
      // Running with nothing loaded looks like success until the child fails
      // for a reason that has nothing to do with this.
      ui.error("no values resolved", "envs load <path> first, or envs doctor");
      return 1;
    }

    ui.info(`running with ${count} values`, command);

    const child = spawnSync(command, rest, {
      cwd,
      env: target as NodeJS.ProcessEnv,
      stdio: "inherit",
      // The child shares this process group, so a terminal's SIGINT reaches it
      // directly. A signal sent only to this process cannot be forwarded from a
      // synchronous spawn, and config() being synchronous is the harder rule.
      shell: false,
    });

    if (child.error !== undefined) {
      ui.error(`could not run ${command}`, child.error.message);
      return 127;
    }
    if (child.signal !== null && child.signal !== undefined) {
      ui.warn(`${command} was killed`, child.signal);
      // Shell convention, so a caller can tell a signal from an exit code.
      return 128 + (SIGNAL_NUMBER[child.signal] ?? 0);
    }
    return child.status ?? 0;
  },
};

function pick(
  env: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Null means the caller should stop. Both refusals are deliberate: a missing
 * provider and a missing declaration each leave the scope unchosen, and running
 * anyway would load whatever happened to be there.
 */
async function resolveAuto(
  cwd: string,
  ui: { error(message: string, detail?: string): void },
): Promise<{ aliases: readonly string[]; from: string } | null> {
  let resolver;
  try {
    resolver = await loadScopeResolver();
  } catch (error) {
    if (error instanceof ScopeProviderMissingError) {
      ui.error(
        "--auto needs a package that can read a declaration",
        "install @modootoday/envs-config",
      );
      return null;
    }
    throw error;
  }

  const resolution = await resolver(cwd);
  if (resolution === undefined) {
    ui.error(
      "--auto found no declaration",
      `looked at and above ${cwd}; pass --alias instead`,
    );
    return null;
  }
  if (resolution.aliases.length === 0) {
    // An empty scope is not the same as no scope, and neither is "everything".
    ui.error(
      "the declaration names no sources",
      `${resolution.from} resolved to an empty scope`,
    );
    return null;
  }
  return resolution;
}

const SIGNAL_NUMBER: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};
