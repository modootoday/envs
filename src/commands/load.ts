import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureSource,
  writeRelease,
  type ItemInput,
} from "../catalog/write.js";
import { one, type Command } from "../cli/command.js";
import { unlockDek } from "../crypto/keyring.js";
import { parseEnv, toRecord } from "../format/parse.js";
import { locateCatalogs } from "../loader/locate.js";
import { readEntries, readWraps } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import { resolveUnlock } from "./unlock.js";

export const loadCommand: Command = {
  name: "load",
  describe: "put the values of one or more env files into a new release",
  usage: "envs load <path>... [--alias <name>] [--replace]",
  group: "start here",
  options: [
    {
      name: "alias",
      placeholder: "<name>",
      describe: "name this source explicitly; only with a single path",
    },
    {
      name: "replace",
      boolean: true,
      describe: "drop sources not named here instead of carrying them forward",
    },
    {
      name: "recovery-code",
      placeholder: "<code|->",
      describe: "unlock with a recovery code; - reads it from stdin",
    },
  ],

  run({ ui, args, env, cwd }) {
    if (args.positional.length === 0) {
      ui.error("no paths given", "envs load <path>...");
      return 2;
    }
    const explicitAlias = one(args, "alias");
    if (explicitAlias !== undefined && args.positional.length > 1) {
      ui.error("--alias names one source", "give a single path with it");
      return 2;
    }

    const located = locateCatalogs({ cwd, env });
    if (!existsSync(located.project)) {
      ui.error("no catalog here", located.project);
      ui.info("run envs init first");
      return 1;
    }

    // Every file is parsed before anything is written: a release that holds
    // three of four files is worse than one that was refused.
    const parsed: {
      path: string;
      values: Record<string, string>;
      digest: string;
    }[] = [];
    for (const given of args.positional) {
      const path = resolve(cwd, given);
      if (!existsSync(path)) {
        ui.error(path, "no such file");
        return 1;
      }
      const text = readFileSync(path, "utf8");
      const result = parseEnv(text);
      const record = toRecord(result);
      if (record === null) {
        ui.error(path, `${result.findings.length} problems, nothing loaded`);
        ui.table(
          result.findings.map((f) => [`line ${f.line}`, f.code]),
          "    ",
        );
        return 1;
      }
      parsed.push({
        path,
        values: record,
        digest: createHash("sha256").update(text).digest("hex"),
      });
    }

    const unlock = resolveUnlock(one(args, "recovery-code"), env);
    if (typeof unlock === "string") {
      ui.error(unlock);
      return 2;
    }

    const db = openDatabaseSync(located.project);
    try {
      const dek = unlockDek(readWraps(db), unlock);

      const named = new Set<string>();
      const items: ItemInput[] = [];
      for (const file of parsed) {
        const source = ensureSource(db, file.path, {
          ...(explicitAlias ? { alias: explicitAlias } : {}),
          digest: file.digest,
        });
        named.add(source.sourceId);
        for (const [key, value] of Object.entries(file.values)) {
          items.push({ sourceId: source.sourceId, key, value });
        }
      }

      // Sources not in this load keep their values unless --replace, so loading
      // one file does not silently empty the others.
      let carried = 0;
      if (!args.flags.has("replace")) {
        try {
          for (const entry of readEntries(db, { unlock })) {
            if (named.has(entry.sourceId)) continue;
            items.push({
              sourceId: entry.sourceId,
              key: entry.key,
              value: entry.value,
            });
            carried += 1;
          }
        } catch {
          // No current release yet: there is nothing to carry.
        }
      }

      const release = writeRelease(db, dek, items, {
        note: `load ${parsed.map((f) => f.path).join(", ")}`,
      });

      for (const file of parsed) {
        ui.success(file.path, `${Object.keys(file.values).length} keys`);
      }
      if (carried > 0) {
        ui.info(
          `carried ${carried} values from other sources`,
          "use --replace to drop them",
        );
      }
      ui.success(
        `release ${release.revisionId.slice(0, 8)} is current`,
        `${release.count} values`,
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
