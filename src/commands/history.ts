import { existsSync } from "node:fs";

import { currentRevisionId, movePointer } from "../catalog/write.js";
import { one, type Command } from "../cli/command.js";
import { locateCatalogs } from "../loader/locate.js";
import { openDatabaseSync, type Database } from "../sqlite/open.js";

interface ReleaseRow {
  revision_id: string;
  created_at: string;
  note: string | null;
  items: number;
}

function releases(db: Database, limit: number): ReleaseRow[] {
  return db
    .prepare<ReleaseRow>(
      `SELECT r.revision_id, r.created_at, r.note,
              (SELECT count(*) FROM items i WHERE i.revision_id = r.revision_id) AS items
         FROM releases r
        ORDER BY r.created_at DESC, r.rowid DESC
        LIMIT $limit`,
    )
    .all({ limit });
}

function openHere(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  const located = locateCatalogs({ cwd, env });
  if (!existsSync(located.project)) return located.project;
  return { db: openDatabaseSync(located.project), path: located.project };
}

export const historyCommand: Command = {
  name: "history",
  describe: "list releases and say which one is current",
  usage: "envs history [--limit <n>]",
  group: "history",
  options: [
    {
      name: "limit",
      placeholder: "<n>",
      describe: "how many to show (default 20)",
    },
  ],

  run({ ui, args, env, cwd }) {
    const opened = openHere(cwd, env);
    if (typeof opened === "string") {
      ui.error("no catalog here", opened);
      ui.info("run envs init first");
      return 1;
    }
    const { db, path } = opened;
    try {
      const limit = Number(one(args, "limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1) {
        ui.error("--limit must be a whole number of at least 1");
        return 2;
      }
      const current = currentRevisionId(db);
      const rows = releases(db, limit);
      if (rows.length === 0) {
        ui.info("no releases yet", "envs load <path> makes the first");
        return 0;
      }
      ui.heading(path);
      ui.table(
        rows.map((row) => [
          `${row.revision_id === current ? "*" : " "} ${row.revision_id.slice(0, 8)}`,
          `${row.created_at}  ${row.items} values  ${row.note ?? ""}`.trimEnd(),
        ]),
      );
      ui.info("* is current", "envs rollback <id> moves the pointer");
      return 0;
    } finally {
      db.close();
    }
  },
};

export const rollbackCommand: Command = {
  name: "rollback",
  describe: "point at an earlier release",
  usage: "envs rollback <revision-id>",
  group: "history",

  run({ ui, args, env, cwd }) {
    if (args.positional.length !== 1) {
      ui.error("give one revision id", "envs history shows them");
      return 2;
    }
    const opened = openHere(cwd, env);
    if (typeof opened === "string") {
      ui.error("no catalog here", opened);
      ui.info("run envs init first");
      return 1;
    }
    const { db } = opened;
    try {
      const prefix = args.positional[0]!;
      // A prefix is what history prints, so a prefix is what this accepts --
      // but an ambiguous one is refused rather than resolved to the newest.
      const matches = db
        .prepare<{ revision_id: string }>(
          "SELECT revision_id FROM releases WHERE revision_id LIKE $like ORDER BY created_at DESC",
        )
        .all({ like: `${prefix}%` });
      if (matches.length === 0) {
        ui.error(`no release starting with "${prefix}"`);
        return 1;
      }
      if (matches.length > 1) {
        ui.error(
          `"${prefix}" matches ${matches.length} releases`,
          matches.map((m) => m.revision_id.slice(0, 12)).join(", "),
        );
        return 1;
      }
      const target = matches[0]!.revision_id;
      const current = currentRevisionId(db);
      if (target === current) {
        ui.info("already current", target.slice(0, 8));
        return 0;
      }
      // Nothing is deleted: the release being left stays, so this is reversible.
      movePointer(db, target);
      ui.success(
        `now at ${target.slice(0, 8)}`,
        `was ${current?.slice(0, 8) ?? "none"}`,
      );
      return 0;
    } finally {
      db.close();
    }
  },
};
