import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";

/**
 * Creates the catalog directory and narrows it, whether or not it was already
 * there. mkdirSync applies its mode only when it creates, so a directory that
 * predates the call keeps whatever the umask gave it.
 */

export type DirOutcome = "created" | "narrowed" | "ok" | "unsupported";

/**
 * Encryption protects the catalog's contents; it does nothing about the
 * directory. A group-writable one lets another account replace the file with
 * an older copy of the same catalog, which opens under the owner's own key and
 * quietly reinstates a credential they rotated away.
 */
export function ensureCatalogDir(dir: string): DirOutcome {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) === 0) return existed ? "ok" : "created";
    chmodSync(dir, 0o700);
    return existed ? "narrowed" : "created";
  } catch {
    // Not every platform has POSIX modes. Saying so beats reporting a state
    // that was never checked.
    return "unsupported";
  }
}
