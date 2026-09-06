import { spawnSync } from "node:child_process";

import { many, type Command } from "../cli/command.js";
import { config } from "../loader/config.js";

/**
 * The delivery method to prefer. Values reach the child through its environment
 * and never through argv, so nothing lands in a process listing, a shell
 * history or a build artifact.
 */
export const runCommand: Command = {
  name: "run",
  describe: "run a command with the values in its environment",
  usage: "envs run -- <command> [args...]",
  options: [
    {
      name: "alias",
      placeholder: "<name>",
      repeat: true,
      describe: "restrict to these sources, in precedence order",
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

  run({ ui, args, env, cwd }) {
    const [command, ...rest] = args.positional;
    if (command === undefined) {
      ui.error("no command given", "envs run -- node server.js");
      return 2;
    }

    const aliases = many(args, "alias");
    const target: Record<string, string | undefined> = { ...env };
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

const SIGNAL_NUMBER: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};
