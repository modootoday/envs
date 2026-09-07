/**
 * The version this build was made from, baked in at build time. A user asking
 * what they are running must not get the answer from a package.json that a
 * stale dist happens to sit beside.
 */

declare const __ENVS_VERSION__: string | undefined;

export const VERSION: string =
  typeof __ENVS_VERSION__ === "string" ? __ENVS_VERSION__ : "0.0.0-source";
