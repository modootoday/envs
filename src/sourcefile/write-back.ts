import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { assignInDocument } from "../format/assign.js";

/**
 * Write one changed value back into the file a source was loaded from. The new
 * file is built beside the old one with the old one's mode and owner and then
 * renamed over it, so a failure at any step leaves the old file whole. Every
 * reason names the file or the key, never a value.
 */

export type WriteBack =
  | { readonly ok: true; readonly assignments: number }
  | { readonly ok: false; readonly reason: string };

function unchanged(first: Stats, now: Stats): boolean {
  return (
    first.ino === now.ino &&
    first.size === now.size &&
    first.mtimeMs === now.mtimeMs
  );
}

function refuseLink(path: string, stat: Stats): string | undefined {
  if (stat.isSymbolicLink())
    return `${path} is a symbolic link; edit the file it points at by hand`;
  if (!stat.isFile()) return `${path} is not a regular file`;
  if (stat.nlink > 1)
    return `${path} has ${stat.nlink} hard links; a rename would split them`;
  return undefined;
}

function writeTemp(temp: string, text: string, stat: Stats): void {
  const mode = stat.mode & 0o777;
  const fd = openSync(temp, "wx", mode);
  try {
    fchmodSync(fd, mode);
    if (stat.uid !== process.getuid?.() || stat.gid !== process.getgid?.())
      fchownSync(fd, stat.uid, stat.gid);
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every platform can fsync a directory; the rename has happened.
  }
}

export interface WriteBackOptions {
  /** Runs between building the new file and the final check, for tests of a racing writer. */
  readonly beforeRename?: () => void;
}

export function writeBack(
  path: string,
  key: string,
  value: string,
  options: WriteBackOptions = {},
): WriteBack {
  let first: Stats;
  try {
    first = lstatSync(path);
  } catch {
    return { ok: false, reason: `${path} does not exist` };
  }
  const link = refuseLink(path, first);
  if (link !== undefined) return { ok: false, reason: link };

  const before = readFileSync(path, "utf8");
  const assigned = assignInDocument(before, key, value);
  if (!assigned.ok) return assigned;

  const temp = join(
    dirname(path),
    `.${basename(path)}.envs-${randomBytes(6).toString("hex")}`,
  );
  try {
    writeTemp(temp, assigned.text, first);
    options.beforeRename?.();
    const now = lstatSync(path);
    if (!unchanged(first, now) || readFileSync(path, "utf8") !== before) {
      unlinkSync(temp);
      return { ok: false, reason: `${path} changed while it was being edited` };
    }
    renameSync(temp, path);
  } catch (caught) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file was never created.
    }
    const code = (caught as NodeJS.ErrnoException).code ?? "an error";
    return { ok: false, reason: `${path} could not be written (${code})` };
  }
  syncDirectory(dirname(path));
  return { ok: true, assignments: assigned.assignments };
}
