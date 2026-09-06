import { existsSync } from "node:fs";

import type { Command } from "../cli/command.js";
import { migrate, readMeta, SCHEMA_VERSION } from "../catalog/schema.js";
import { locateCatalogs } from "../loader/locate.js";
import { openDatabaseSync } from "../sqlite/open.js";

/**
 * The upgrade every other command refuses to do for you. Opening a catalog
 * reports an old schema rather than changing it, so one run of a floating CLI
 * cannot upgrade a catalog another project has pinned. This is where a person
 * says yes.
 */
export const migrateCommand: Command = {
  name: "migrate",
  describe: "bring an older catalog up to this build's schema",
  usage: "envs migrate",

  run({ ui, env, cwd }) {
    const located = locateCatalogs({ cwd, env });
    if (!existsSync(located.project)) {
      ui.error("no catalog here", located.project);
      return 1;
    }

    const db = openDatabaseSync(located.project);
    try {
      const meta = readMeta(db);
      if (meta === undefined) {
        // A file with no schema_meta is not an old catalog, it is not one.
        ui.error("this file is not a catalog", located.project);
        return 1;
      }
      if (meta.version === SCHEMA_VERSION) {
        ui.info(
          `already at schema ${String(SCHEMA_VERSION)}`,
          "nothing to upgrade",
        );
        return 0;
      }
      const from = meta.version;
      const after = migrate(db);
      // No value is re-encrypted and no release is rewritten: a migration
      // adds shape, so a rollback still points at what it pointed at.
      ui.success(
        `schema ${String(from)} to ${String(after.version)}`,
        located.project,
      );
      return 0;
    } catch (error) {
      ui.error("could not upgrade", (error as Error).message);
      return 1;
    } finally {
      db.close();
    }
  },
};
