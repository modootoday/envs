import { existsSync } from "node:fs";

import { currentRevisionId } from "../catalog/write.js";
import { one, type Command } from "../cli/command.js";
import { locateCatalogs } from "../loader/locate.js";
import { readEntries } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import { resolveUnlock } from "./unlock.js";

/**
 * What is in the catalog, without unsealing anything: sources come from rows
 * that carry no secret. Key names need the key, so they appear only when one is
 * available, and their values never do.
 */
export const lsCommand: Command = {
  name: "ls",
  describe: "list the sources in the catalog, and their keys",
  usage: "envs ls [--keys]",
  group: "values",
  options: [
    {
      name: "keys",
      boolean: true,
      describe: "also list key names (needs a key)",
    },
    {
      name: "recovery-code",
      placeholder: "<code|->",
      describe: "unlock with a recovery code; - reads it from stdin",
    },
  ],

  run({ ui, args, env, cwd }) {
    const located = locateCatalogs({ cwd, env });
    if (!existsSync(located.project)) {
      ui.error("no catalog here", located.project);
      ui.info("run envs init first");
      return 1;
    }

    const db = openDatabaseSync(located.project, { readOnly: true });
    try {
      const sources = db
        .prepare<{
          alias: string;
          path: string;
          added_at: string;
          retired_at: string | null;
        }>(
          "SELECT alias, path, added_at, retired_at FROM sources ORDER BY added_at",
        )
        .all();

      ui.heading(located.project);
      if (sources.length === 0) {
        ui.info("no sources yet", "envs load <path> adds one");
        return 0;
      }
      ui.table(
        sources.map((source) => [
          source.retired_at === null
            ? source.alias
            : `${source.alias} (retired)`,
          source.path,
        ]),
      );

      const revision = currentRevisionId(db);
      ui.line();
      ui.info(
        revision === undefined
          ? "no release yet"
          : `release ${revision.slice(0, 8)} is current`,
        "envs history lists them",
      );

      if (!args.flags.has("keys")) return 0;

      const unlock = resolveUnlock(one(args, "recovery-code"), env);
      if (typeof unlock === "string") {
        ui.error(unlock, "key names are sealed with the values");
        return 2;
      }
      const byAlias = new Map<string, string[]>();
      for (const entry of readEntries(db, { unlock })) {
        byAlias.set(entry.alias, [
          ...(byAlias.get(entry.alias) ?? []),
          entry.key,
        ]);
      }
      ui.line();
      ui.heading("keys");
      for (const [alias, keys] of byAlias) {
        // Names only. Values are what export and get are for.
        ui.table([[alias, keys.sort().join(" ")]]);
      }
      return 0;
    } catch (error) {
      ui.error((error as Error).message);
      return 1;
    } finally {
      db.close();
    }
  },
};
