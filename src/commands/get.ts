import { existsSync } from "node:fs";

import { one, type Command } from "../cli/command.js";
import { locateCatalogs } from "../loader/locate.js";
import { readEntries } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import { resolveUnlock } from "./unlock.js";

const FORMATS: ReadonlySet<string> = new Set([
  "plain",
  "shell",
  "eval",
  "json",
]);

/** Same shapes dotenvx prints, so an existing script does not have to change. */
function render(format: string, key: string, value: string): string {
  if (format === "json")
    return `${JSON.stringify({ [key]: value }, null, 2)}\n`;
  if (format === "shell") return `${key}=${JSON.stringify(value)}\n`;
  if (format === "eval") return `export ${key}=${JSON.stringify(value)}\n`;
  // Bare value: command substitution strips the newline, a redirect keeps it.
  return `${value}\n`;
}

/**
 * One of two commands whose purpose is to produce a value, so it prints one.
 * The rule the rest of the package keeps -- diagnostics never print values --
 * is unchanged; this is not a diagnostic.
 */
export const getCommand: Command = {
  name: "get",
  describe: "print one value",
  usage: "envs get <KEY> [--format shell|eval|json]",
  group: "values",
  options: [
    {
      name: "source",
      placeholder: "<alias>",
      describe: "read the key from this source rather than the winner",
    },
    {
      name: "format",
      placeholder: "<fmt>",
      describe: "plain (default), shell, eval or json",
    },
    {
      name: "include-global",
      boolean: true,
      describe: "also look in the machine-wide layer",
    },
    {
      name: "recovery-code",
      placeholder: "<code|->",
      describe: "unlock with a recovery code; - reads it from stdin",
    },
  ],

  run({ ui, args, env, cwd }) {
    if (args.positional.length !== 1) {
      ui.error(
        "give exactly one key",
        "envs ls --keys lists them; envs export prints values",
      );
      return 2;
    }
    const key = args.positional[0]!;

    const located = locateCatalogs({ cwd, env });
    if (!existsSync(located.project)) {
      ui.error("no catalog here", located.project);
      ui.info("run envs init first");
      return 1;
    }
    const unlock = resolveUnlock(one(args, "recovery-code"), env);
    if (typeof unlock === "string") {
      ui.error(unlock);
      return 2;
    }

    const paths = [located.project];
    if (args.flags.has("include-global") && located.global !== undefined) {
      paths.push(located.global);
    }

    const format = one(args, "format") ?? "plain";
    if (!FORMATS.has(format)) {
      ui.error(`unknown format "${format}"`, "use plain, shell, eval or json");
      return 2;
    }

    const wantedSource = one(args, "source");
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const db = openDatabaseSync(path, { readOnly: true });
      try {
        for (const entry of readEntries(db, { unlock })) {
          if (entry.key !== key) continue;
          if (wantedSource !== undefined && entry.alias !== wantedSource)
            continue;
          ui.data(render(format, key, entry.value));
          return 0;
        }
      } catch (error) {
        ui.error((error as Error).message);
        return 1;
      } finally {
        db.close();
      }
    }

    ui.error(
      `no value for ${key}`,
      wantedSource === undefined
        ? "envs doctor --key lists what declares it"
        : `not in source ${wantedSource}`,
    );
    return 1;
  },
};
