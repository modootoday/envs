import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { one, type Command } from "../cli/command.js";
import type { Ui } from "../cli/ui.js";
import { locateCatalogs } from "../loader/locate.js";
import { readEntries } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import { resolveUnlock } from "./unlock.js";

const IGNORE_LINE = ".envs/";

export function ensureIgnored(root: string, ui: Ui): boolean {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, `${IGNORE_LINE}\n`);
    ui.success("created .gitignore", IGNORE_LINE);
    return true;
  }
  const text = readFileSync(path, "utf8");
  if (text.split(/\r?\n/).some((line) => line.trim() === IGNORE_LINE)) {
    ui.info(".gitignore already ignores .envs/", "left alone");
    return false;
  }
  appendFileSync(
    path,
    text.endsWith("\n") ? `${IGNORE_LINE}\n` : `\n${IGNORE_LINE}\n`,
  );
  ui.success("added to .gitignore", IGNORE_LINE);
  return true;
}

export const gitignoreCommand: Command = {
  name: "gitignore",
  describe: "make sure git ignores the catalog",
  usage: "envs gitignore",
  group: "check",

  run({ ui, env, cwd }) {
    const located = locateCatalogs({ cwd, env });
    if (located.projectRoot === undefined) {
      ui.error("no project root here", "nothing to ignore");
      return 1;
    }
    ensureIgnored(located.projectRoot, ui);
    return 0;
  },
};

/** Paths git is tracking. Empty when this is not a repository. */
function trackedFiles(root: string): Set<string> {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.split("\0").filter((line) => line !== ""));
  } catch {
    return new Set();
  }
}

export const precommitCommand: Command = {
  name: "precommit",
  describe: "refuse the commit if a secret is about to go into it",
  usage: "envs precommit",
  group: "check",
  options: [
    {
      name: "recovery-code",
      placeholder: "<code|->",
      describe: "unlock with a recovery code; - reads it from stdin",
    },
  ],

  run({ ui, args, env, cwd }) {
    const located = locateCatalogs({ cwd, env });
    const root = located.projectRoot;
    if (root === undefined) {
      ui.error("no project root here", "nothing to check");
      return 1;
    }
    const tracked = trackedFiles(root);
    if (tracked.size === 0) {
      ui.warn("git tracks nothing here", "not a repository, or an empty one");
      return 0;
    }

    const problems: string[] = [];

    // The catalog itself. Encrypted, but it carries history and audit rows, and
    // a key that leaks later opens everything committed before it.
    const catalogRel = relative(root, located.project);
    if (!catalogRel.startsWith("..") && tracked.has(catalogRel)) {
      problems.push(
        `${catalogRel} is tracked — the catalog must not be committed`,
      );
    }

    // Plaintext files this catalog was loaded from. These are the real hazard:
    // the values are readable by anyone with the repository.
    if (existsSync(located.project)) {
      const unlock = resolveUnlock(one(args, "recovery-code"), env);
      if (typeof unlock !== "string") {
        const db = openDatabaseSync(located.project, { readOnly: true });
        try {
          const seen = new Set<string>();
          for (const entry of readEntries(db, { unlock })) {
            if (seen.has(entry.path) || entry.path.startsWith("envs:"))
              continue;
            seen.add(entry.path);
            const rel = relative(root, entry.path);
            if (!rel.startsWith("..") && tracked.has(rel)) {
              problems.push(`${rel} is tracked and holds plaintext values`);
            }
          }
        } catch {
          // No release yet, or no key: the catalog check above still ran.
        } finally {
          db.close();
        }
      } else {
        ui.info(
          "no key available",
          "checked tracked files only, not their contents",
        );
      }
    }

    if (problems.length === 0) {
      ui.success("nothing tracked that should not be");
      return 0;
    }
    for (const problem of problems) ui.error(problem);
    ui.info(
      "git rm --cached <path>",
      "removes it from the commit, keeps the file",
    );
    return 1;
  },
};

export const genexampleCommand: Command = {
  name: "genexample",
  describe: "write an example file with the key names and no values",
  usage: "envs genexample [--out <path>] [--requires]",
  group: "check",
  options: [
    {
      name: "out",
      placeholder: "<path>",
      describe: "where to write (default .env.example)",
    },
    {
      name: "requires",
      boolean: true,
      describe:
        "write envs.requires instead — names only, for config() to enforce",
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
    const unlock = resolveUnlock(one(args, "recovery-code"), env);
    if (typeof unlock === "string") {
      ui.error(unlock, "key names are sealed with the values");
      return 2;
    }

    const db = openDatabaseSync(located.project, { readOnly: true });
    let keys: string[];
    try {
      keys = [
        ...new Set(readEntries(db, { unlock }).map((entry) => entry.key)),
      ].sort();
    } catch (error) {
      ui.error((error as Error).message);
      return 1;
    } finally {
      db.close();
    }
    if (keys.length === 0) {
      ui.error("no values to describe", "envs load <path> first");
      return 1;
    }

    const wantRequires = args.flags.has("requires");
    const target =
      one(args, "out") ?? (wantRequires ? "envs.requires" : ".env.example");
    const path = join(located.projectRoot ?? cwd, target);

    // Names only, never a value and never a hint: an example value is the
    // classic way a secret ends up in a repository.
    const body = wantRequires
      ? `${keys.join("\n")}\n`
      : `${keys.map((key) => `${key}=`).join("\n")}\n`;
    writeFileSync(path, body);

    ui.success(`wrote ${target}`, `${keys.length} keys, no values`);
    if (wantRequires) {
      ui.info("commit it", "config() then fails loudly when one is missing");
    }
    return 0;
  },
};
