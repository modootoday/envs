#!/usr/bin/env node
/**
 * Refuses a publish that would go nowhere or go out mislabelled.
 *
 * Three ways a release goes wrong quietly: the version is already on the
 * registry so npm rejects it after the gates have run; the built artifact was
 * made from an older manifest and reports a version nobody shipped; or the
 * version moves backwards. None of these show up in a build or a unit test.
 *
 * Run: node scripts/check-version.mjs [--offline]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { versionClaims } from "./version-claims.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { name, version } = manifest;

const problems = [];
const said = [];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const parsed = SEMVER.exec(version);
if (!parsed) problems.push(`version "${version}" is not semver`);
said.push(`manifest      ${name}@${version}`);

// The built CLI must report the manifest's version. A dist left over from an
// earlier bump answers --version with a number that was never published.
const cli = join(root, "dist", "cli.js");
if (!existsSync(cli)) {
  said.push("built cli     absent, run npm run build first");
} else {
  const reported = execFileSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
  }).trim();
  said.push(`built cli     ${reported}`);
  if (reported !== version) {
    problems.push(
      `the built cli reports ${reported} and the manifest says ${version}; rebuild`,
    );
  }
}

// A version written into the public surface goes stale silently: the page keeps
// claiming a release nobody can install.
const surface = [join(root, "README.md")];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(html|md|json|txt|xml)$/.test(entry.name)) surface.push(path);
  }
};
walk(join(root, "docs"));

const stale = [];
for (const file of surface) {
  for (const claimed of versionClaims(readFileSync(file, "utf8"))) {
    if (claimed !== version) {
      stale.push(`${file.slice(root.length + 1)} claims ${claimed}`);
    }
  }
}
said.push(`public surface  ${surface.length} files scanned`);
for (const s of stale) problems.push(`${s}, manifest says ${version}`);

if (!process.argv.includes("--offline")) {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  let published = [];
  let latest = null;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      said.push("registry      never published");
    } else if (!res.ok) {
      said.push(`registry      unreadable (HTTP ${res.status})`);
    } else {
      const body = await res.json();
      published = Object.keys(body.versions ?? {});
      latest = body["dist-tags"]?.latest ?? null;
      said.push(`registry      latest ${latest}, ${published.length} versions`);
    }
  } catch (error) {
    // Reported, not swallowed: a check that cannot reach the registry has not
    // cleared the release, and saying so beats a silent pass.
    said.push(`registry      unreachable (${String(error).slice(0, 60)})`);
    problems.push(
      "could not reach the registry, so nothing here clears a publish",
    );
  }

  if (published.includes(version)) {
    problems.push(`${version} is already published; bump before publishing`);
  }
  if (latest && parsed) {
    const l = SEMVER.exec(latest);
    if (l) {
      const a = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
      const b = [Number(l[1]), Number(l[2]), Number(l[3])];
      const behind =
        a[0] < b[0] ||
        (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
      if (behind) problems.push(`${version} is behind the published ${latest}`);
    }
  }
}

for (const line of said) console.log(`  ${line}`);
if (problems.length > 0) {
  console.error("");
  for (const p of problems) console.error(`  x ${p}`);
  process.exit(1);
}
console.log("  ok            this version can be published");
