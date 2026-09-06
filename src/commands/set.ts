import { existsSync } from "node:fs";

import {
  ensureSource,
  writeRelease,
  type ItemInput,
} from "../catalog/write.js";
import { one, type Command } from "../cli/command.js";
import { unlockDek } from "../crypto/keyring.js";
import { hashKeyName } from "../crypto/envelope.js";
import { parseEnv } from "../format/parse.js";
import { isSensitivity } from "./build.js";
import { locateCatalogs } from "../loader/locate.js";
import { readEntries, readWraps } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import { resolveUnlock } from "./unlock.js";

/** The assignment is parsed by the same rule a file is, so quoting matches. */
function parseAssignment(
  text: string,
): { key: string; value: string } | string {
  const result = parseEnv(text);
  const assignments = result.entries.filter((e) => e.kind === "assignment");
  if (!result.ok || assignments.length !== 1) {
    return `"${text.split("=")[0] ?? text}" is not a single KEY=VALUE assignment`;
  }
  const [entry] = assignments;
  return { key: entry!.key!, value: entry!.value! };
}

export const setCommand: Command = {
  name: "set",
  describe: "change one value, as a new release",
  usage: "envs set KEY VALUE  |  envs set KEY=VALUE",
  options: [
    {
      name: "source",
      placeholder: "<alias>",
      describe:
        "which source owns the key; required when there is more than one",
    },
    {
      name: "sensitivity",
      placeholder: "<level>",
      describe: "low, medium, high or critical; only low may be baked by build",
    },
    {
      name: "recovery-code",
      placeholder: "<code|->",
      describe: "unlock with a recovery code; - reads it from stdin",
    },
  ],

  run({ ui, args, env, cwd }) {
    // Both spellings, because every comparable tool takes one or the other:
    // dotenvx and infisical write "set KEY value", doppler writes "set KEY=value".
    const [first, second] = args.positional;
    if (first === undefined || args.positional.length > 2) {
      ui.error("give one KEY=VALUE or KEY VALUE", "envs set KEY VALUE");
      return 2;
    }
    // Mixing the two forms is ambiguous -- "set A=1 B=2" could be either -- so
    // it is refused rather than read as a key called "A=1".
    if (second !== undefined && first.includes("=")) {
      ui.error(
        "that mixes both spellings",
        'either "set KEY VALUE" or "set KEY=VALUE", not both',
      );
      return 2;
    }
    const joined = second === undefined ? first : `${first}=${second}`;
    const assignment = parseAssignment(joined);
    if (typeof assignment === "string") {
      ui.error(assignment);
      return 2;
    }

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

    const db = openDatabaseSync(located.project);
    try {
      const dek = unlockDek(readWraps(db), unlock);

      const sources = db
        .prepare<{ source_id: string; alias: string; path: string }>(
          "SELECT source_id, alias, path FROM sources WHERE retired_at IS NULL ORDER BY added_at",
        )
        .all();

      const wanted = one(args, "source");
      let target:
        { source_id: string; alias: string; path: string } | undefined;
      if (wanted !== undefined) {
        target = sources.find((source) => source.alias === wanted);
        if (target === undefined) {
          ui.error(
            `no source "${wanted}"`,
            sources.map((s) => s.alias).join(", "),
          );
          return 1;
        }
      } else if (sources.length === 1) {
        target = sources[0]!;
      } else if (sources.length === 0) {
        // A value with no source has no provenance, and provenance is the point.
        const created = ensureSource(db, "envs:set", { alias: "set" });
        target = {
          source_id: created.sourceId,
          alias: created.alias,
          path: created.path,
        };
        ui.info(
          `created source "${created.alias}"`,
          "values set by hand live here",
        );
      } else {
        // Picking one silently would write into a file the caller did not name.
        ui.error(
          "more than one source; say which with --source",
          sources.map((s) => s.alias).join(", "),
        );
        return 2;
      }

      // Releases are immutable, so this carries the current one forward with
      // the single key replaced. That is what makes rollback a pointer move.
      const items: ItemInput[] = [];
      let replaced = false;
      try {
        for (const entry of readEntries(db, { unlock })) {
          if (
            entry.sourceId === target.source_id &&
            entry.key === assignment.key
          ) {
            replaced = true;
            continue;
          }
          items.push({
            sourceId: entry.sourceId,
            key: entry.key,
            value: entry.value,
          });
        }
      } catch {
        // Nothing released yet; this becomes the first release.
      }
      items.push({
        sourceId: target.source_id,
        key: assignment.key,
        value: assignment.value,
      });

      const release = writeRelease(db, dek, items, {
        note: `set ${assignment.key} in ${target.alias}`,
      });

      const level = one(args, "sensitivity");
      if (level !== undefined) {
        if (!isSensitivity(level)) {
          ui.error(
            `"${level}" is not a level`,
            "low, medium, high or critical",
          );
          return 2;
        }
        db.prepare(
          "UPDATE keys SET sensitivity = $level WHERE key_hash = $hash",
        ).run({ level, hash: hashKeyName(dek, assignment.key) });
        ui.info(`classified ${assignment.key}`, level);
      }

      // The key, the source and whether it existed. Never the value.
      ui.success(
        `${replaced ? "replaced" : "added"} ${assignment.key}`,
        `source ${target.alias}`,
      );
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
