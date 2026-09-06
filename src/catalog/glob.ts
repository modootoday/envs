/**
 * A small path matcher. Written here rather than depended on: the package ships
 * no runtime dependencies, and what watch needs is the familiar subset.
 */

/** `*` stops at a separator, `**` crosses them, `?` is one character. */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // A trailing or separator-bounded ** also matches zero segments, so
        // "a/**" matches "a" itself rather than only its children.
        const slash = pattern[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/** True when any include matches and no exclude does. Excludes always win. */
export function selected(
  path: string,
  includes: readonly string[],
  excludes: readonly string[],
): boolean {
  if (excludes.some((pattern) => matchesGlob(pattern, path))) return false;
  return includes.some((pattern) => matchesGlob(pattern, path));
}

/** The names cwd is scanned for without anyone registering them. */
export const DEFAULT_INCLUDES: readonly string[] = [".env", ".env.*", "*.env"];

export const DEFAULT_EXCLUDES: readonly string[] = [
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
  "**/node_modules/**",
  "**/.envs/**",
];
