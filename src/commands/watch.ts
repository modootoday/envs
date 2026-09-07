import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  DEFAULT_EXCLUDES,
  DEFAULT_INCLUDES,
  selected,
} from "../catalog/glob.js";
import { audit } from "../catalog/write.js";
import { type Command } from "../cli/command.js";
import { locateCatalogs } from "../loader/locate.js";
import { openDatabaseSync, type Database } from "../sqlite/open.js";

export interface WatchTarget {
  readonly pattern: string;
  readonly mode: "include" | "exclude";
}

export function readTargets(db: Database): WatchTarget[] {
  return db
    .prepare<{ pattern: string; mode: string }>(
      "SELECT pattern, mode FROM watch_targets ORDER BY added_at, pattern",
    )
    .all()
    .map((row) => ({
      pattern: row.pattern,
      mode: row.mode === "exclude" ? "exclude" : "include",
    }));
}

/** Paths under root that the targets select, with the defaults applied. */
export function scan(root: string, targets: readonly WatchTarget[]): string[] {
  const includes = [
    ...DEFAULT_INCLUDES,
    ...targets.filter((t) => t.mode === "include").map((t) => t.pattern),
  ];
  const excludes = [
    ...DEFAULT_EXCLUDES,
    ...targets.filter((t) => t.mode === "exclude").map((t) => t.pattern),
  ];

  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) {
        // Excludes are consulted for directories too, so node_modules is not
        // walked before being rejected file by file.
        if (selected(`${rel}/`, ["**"], excludes)) walk(full, depth + 1);
        continue;
      }
      if (selected(rel, includes, excludes)) found.push(full);
    }
  };
  walk(root, 0);
  return found.sort();
}

function open(cwd: string, env: Readonly<Record<string, string | undefined>>) {
  const located = locateCatalogs({ cwd, env });
  if (!existsSync(located.project)) return located.project;
  return { db: openDatabaseSync(located.project), located };
}

const SUB = new Set(["add", "exclude", "list", "remove", "scan"]);

export const watchCommand: Command = {
  name: "watch",
  describe: "choose which env files this project looks at",
  usage: "envs watch add|exclude|remove <pattern>  |  envs watch list|scan",
  group: "backup",

  run({ ui, args, env, cwd }) {
    const [sub, ...rest] = args.positional;
    if (sub === undefined || !SUB.has(sub)) {
      ui.error(
        sub === undefined ? "no subcommand" : `unknown subcommand "${sub}"`,
        [...SUB].join(", "),
      );
      return 2;
    }

    const opened = open(cwd, env);
    if (typeof opened === "string") {
      ui.error("no catalog here", opened);
      ui.info("run envs init first");
      return 1;
    }
    const { db, located } = opened;
    const root = located.projectRoot ?? cwd;

    try {
      if (sub === "list") {
        const targets = readTargets(db);
        ui.heading("always looked at");
        ui.table(DEFAULT_INCLUDES.map((pattern) => [pattern, "default"]));
        ui.heading("never looked at");
        ui.table(DEFAULT_EXCLUDES.map((pattern) => [pattern, "default"]));
        if (targets.length > 0) {
          ui.line();
          ui.heading("added here");
          ui.table(targets.map((target) => [target.pattern, target.mode]));
        }
        return 0;
      }

      if (sub === "scan") {
        const paths = scan(root, readTargets(db));
        if (paths.length === 0) {
          ui.info("nothing matched", "envs watch add <pattern> widens it");
          return 0;
        }
        ui.heading(`${paths.length} files`);
        ui.table(paths.map((path) => [relative(root, path), ""]));
        ui.info("envs load <path>...", "puts them in a release");
        return 0;
      }

      const pattern = rest[0];
      if (pattern === undefined || rest.length > 1) {
        ui.error("give exactly one pattern", `envs watch ${sub} <pattern>`);
        return 2;
      }

      if (sub === "remove") {
        const gone = db
          .prepare("DELETE FROM watch_targets WHERE pattern = $pattern")
          .run({ pattern });
        if (Number(gone.changes) === 0) {
          ui.error(`no target "${pattern}"`, "envs watch list shows them");
          return 1;
        }
        audit(db, "watch.remove", pattern);
        ui.success("removed", pattern);
        return 0;
      }

      // A path is stored relative to the root, so a catalog stays usable when
      // the checkout moves.
      const stored = pattern.startsWith("/")
        ? relative(root, resolve(pattern)).split(sep).join("/")
        : pattern;
      const mode = sub === "exclude" ? "exclude" : "include";
      try {
        db.prepare(
          "INSERT INTO watch_targets (target_id, pattern, mode, added_at) VALUES ($id, $pattern, $mode, $at)",
        ).run({
          id: randomUUID(),
          pattern: stored,
          mode,
          at: new Date().toISOString(),
        });
      } catch {
        ui.error(
          `"${stored}" is already a target`,
          "envs watch list shows them",
        );
        return 1;
      }
      audit(db, `watch.${mode}`, stored);
      ui.success(`${mode} ${stored}`);

      if (mode === "include") {
        const absolute = resolve(root, stored);
        // A directory here is a common mistake: it selects nothing on its own,
        // and saying so now is cheaper than an empty scan later.
        if (existsSync(absolute) && statSync(absolute).isDirectory()) {
          ui.warn(
            "that is a directory, so it matches no file by itself",
            `did you mean ${stored}/**`,
          );
        }
      }
      const matched = scan(root, readTargets(db)).length;
      ui.info(`${matched} files match now`, "envs watch scan lists them");
      return 0;
    } finally {
      db.close();
    }
  },
};
