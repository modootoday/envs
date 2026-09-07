import { existsSync } from "node:fs";

import { writeRelease, type ItemInput } from "../catalog/write.js";
import { one, type Command } from "../cli/command.js";
import { unlockDek } from "../crypto/keyring.js";
import { locateCatalogs } from "../loader/locate.js";
import { readEntries, readWraps } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import { resolveUnlock } from "./unlock.js";

/**
 * Removing a key is a new release without it, like every other change. The
 * release it was in stays, so a rollback brings it back.
 */
export const delCommand: Command = {
  name: "del",
  describe: "remove one key, as a new release",
  usage: "envs del <KEY> [--source <alias>]",
  group: "values",
  options: [
    {
      name: "source",
      placeholder: "<alias>",
      describe: "remove it from this source only",
    },
    {
      name: "recovery-code",
      placeholder: "<code|->",
      describe: "unlock with a recovery code; - reads it from stdin",
    },
  ],

  run({ ui, args, env, cwd }) {
    if (args.positional.length !== 1) {
      ui.error("give exactly one key", "envs del <KEY>");
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

    const wantedSource = one(args, "source");
    const db = openDatabaseSync(located.project);
    try {
      const dek = unlockDek(readWraps(db), unlock);

      const items: ItemInput[] = [];
      const removedFrom: string[] = [];
      for (const entry of readEntries(db, { unlock })) {
        const matches =
          entry.key === key &&
          (wantedSource === undefined || entry.alias === wantedSource);
        if (matches) {
          removedFrom.push(entry.alias);
          continue;
        }
        items.push({
          sourceId: entry.sourceId,
          key: entry.key,
          value: entry.value,
        });
      }

      if (removedFrom.length === 0) {
        // Writing a release identical to the current one would look like work.
        ui.error(
          `no value for ${key}`,
          wantedSource === undefined
            ? "nothing removed"
            : `not in ${wantedSource}`,
        );
        return 1;
      }

      const release = writeRelease(db, dek, items, {
        note: `del ${key} from ${removedFrom.join(", ")}`,
      });
      ui.success(`removed ${key}`, `from ${removedFrom.join(", ")}`);
      ui.success(
        `release ${release.revisionId.slice(0, 8)} is current`,
        `${release.count} values — envs rollback brings it back`,
      );
      return 0;
    } catch (error) {
      ui.error((error as Error).message);
      return 1;
    } finally {
      db.close();
    }
  },
};
