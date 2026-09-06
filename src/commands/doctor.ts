import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { one, type Command } from "../cli/command.js";
import type { Ui } from "../cli/ui.js";
import { locateCatalogs } from "../loader/locate.js";
import { readEntries, type CatalogEntry } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import { resolveUnlock } from "./unlock.js";

interface Finding {
  readonly level: "error" | "warn";
  readonly what: string;
  readonly detail: string;
}

type Layer = "project" | "global";
type Layered = CatalogEntry & { layer: Layer };

function read(
  path: string,
  layer: Layer,
  unlock: Parameters<typeof readEntries>[1]["unlock"],
): Layered[] {
  if (!existsSync(path)) return [];
  const db = openDatabaseSync(path, { readOnly: true });
  try {
    return readEntries(db, { unlock }).map((entry) => ({ ...entry, layer }));
  } catch {
    // A catalog with no release yet is a state, not a fault.
    return [];
  } finally {
    db.close();
  }
}

/**
 * Same value warns, different value errors, neither prints the value. That is
 * the convention the workspace lint rule set, answered from the store rather
 * than by re-reading files.
 */
function conflicts(entries: readonly Layered[]): Finding[] {
  const byKey = new Map<string, Layered[]>();
  for (const entry of entries) {
    byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  }
  const findings: Finding[] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const same = group.every((entry) => entry.value === group[0]!.value);
    const where = group.map((e) => `${e.layer}:${e.alias}`).join(" and ");
    findings.push({
      level: same ? "warn" : "error",
      what: key,
      detail: same
        ? `declared twice, same value — ${where}`
        : `values differ — ${where}`,
    });
  }
  return findings;
}

/** Exactly where two people disagree without being able to see why. */
function globalOnly(entries: readonly Layered[]): Finding[] {
  const inProject = new Set(
    entries.filter((e) => e.layer === "project").map((e) => e.key),
  );
  return entries
    .filter((entry) => entry.layer === "global" && !inProject.has(entry.key))
    .map((entry) => ({
      level: "warn" as const,
      what: entry.key,
      detail: `only in the machine-wide layer — a teammate will not have it`,
    }));
}

function ghosts(entries: readonly Layered[]): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path) || entry.path.startsWith("envs:")) continue;
    seen.add(entry.path);
    if (!existsSync(entry.path)) {
      findings.push({
        level: "warn",
        what: entry.alias,
        detail: `the file it was loaded from is gone — ${entry.path}`,
      });
    }
  }
  return findings;
}

/**
 * An error rather than a warning: for a tool holding secrets, not helping
 * someone commit them is not enough.
 */
function catalogIgnored(
  catalogPath: string,
  root: string | undefined,
): Finding[] {
  if (root === undefined) return [];
  const rel = relative(root, catalogPath);
  if (rel.startsWith("..")) return [];

  const ignoreFile = join(root, ".gitignore");
  const lines = existsSync(ignoreFile)
    ? readFileSync(ignoreFile, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
    : [];
  if (lines.includes(".envs/") || lines.includes(".envs")) return [];
  return [
    {
      level: "error",
      what: "the catalog is not ignored by git",
      detail: `add .envs/ to .gitignore — ${rel}`,
    },
  ];
}

function report(ui: Ui, findings: readonly Finding[]): void {
  for (const finding of findings) {
    if (finding.level === "error") ui.error(finding.what, finding.detail);
    else ui.warn(finding.what, finding.detail);
  }
}

export const doctorCommand: Command = {
  name: "doctor",
  describe: "say where each value comes from, and what disagrees",
  usage: "envs doctor [--key <KEY>]",
  options: [
    {
      name: "key",
      placeholder: "<KEY>",
      describe: "one key's sources and which one wins",
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
      ui.error(unlock);
      return 2;
    }

    // Which catalogs were actually read. Running in the wrong directory is the
    // one trap this layout has, so it is never left implicit.
    ui.heading("catalogs");
    ui.table([
      ["project", located.project],
      ["global", located.global ?? "(none — this is the machine-wide catalog)"],
    ]);
    ui.line();

    const entries = [
      ...read(located.project, "project", unlock),
      ...(located.global ? read(located.global, "global", unlock) : []),
    ];

    const wanted = one(args, "key");
    if (wanted !== undefined) {
      const group = entries.filter((entry) => entry.key === wanted);
      if (group.length === 0) {
        ui.warn(`no source declares ${wanted}`);
        return 1;
      }
      ui.heading(wanted);
      // The winner is named by its source. The value is not printed.
      ui.table(
        group.map((entry, index) => [
          `${index === 0 ? "*" : " "} ${entry.layer}:${entry.alias}`,
          entry.path,
        ]),
      );
      ui.info("* wins", "project beats global; earlier source beats later");
      return 0;
    }

    const findings = [
      ...catalogIgnored(located.project, located.projectRoot),
      ...conflicts(entries),
      ...globalOnly(entries),
      ...ghosts(entries),
    ];

    ui.heading("values");
    ui.table([
      ["keys", String(new Set(entries.map((entry) => entry.key)).size)],
      ["sources", String(new Set(entries.map((entry) => entry.alias)).size)],
    ]);
    ui.line();

    if (findings.length === 0) {
      ui.success("nothing to report");
      return 0;
    }
    ui.heading("findings");
    report(ui, findings);
    return findings.some((finding) => finding.level === "error") ? 1 : 0;
  },
};
