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

import { surfaceDiff, surfaceMoved, surfaceOf } from "./surface.mjs";
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

/**
 * Which part of the version may move. Chosen from what a consumer can see, not
 * from how much work went in: a verb or a flag arriving or leaving is a minor,
 * and everything else is a patch.
 *
 * Measured 20260907, which is why this is enforced rather than remembered: two
 * findings were added to doctor and the release went out as a minor, but both
 * were warnings, doctor exited 0 before and after, and nothing a caller could
 * see had moved. "More functionality" was the reason given, and it was decided
 * after the fact.
 */
async function versionRule() {
  const snapPath = join(root, "scripts", "surface.json");
  const dist = join(root, "dist", "index.js");
  if (!existsSync(snapPath) || !existsSync(dist)) return null;
  const snapshot = JSON.parse(readFileSync(snapPath, "utf8"));
  const { COMMANDS } = await import(`file://${dist}`);
  const diff = surfaceDiff(snapshot.commands, surfaceOf(COMMANDS));
  const moved = surfaceMoved(diff);
  const [major, minor] = version.split(".").map(Number);
  const [wasMajor, wasMinor] = String(snapshot.version).split(".").map(Number);
  const bumpedMinor = major > wasMajor || minor > wasMinor;
  const detail = [
    ...diff.added.map((n) => `+${n}`),
    ...diff.gone.map((n) => `-${n}`),
    ...diff.changed,
  ].join(", ");
  return { moved, bumpedMinor, detail, snapshotVersion: snapshot.version };
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

const rule = await versionRule();
if (rule) {
  said.push(
    `surface       ${rule.moved ? `moved since ${rule.snapshotVersion}: ${rule.detail}` : `unchanged since ${rule.snapshotVersion}`}`,
  );
  if (rule.moved && !rule.bumpedMinor) {
    problems.push(
      `a verb or flag moved (${rule.detail}) so the minor must move, and ${version} only bumps the patch`,
    );
  }
  if (!rule.moved && rule.bumpedMinor) {
    problems.push(
      `nothing a caller can see changed since ${rule.snapshotVersion}, so ${version} should have been a patch`,
    );
  }
  if (rule.moved && rule.bumpedMinor) {
    problems.push(
      `the surface moved, so update scripts/surface.json in this commit (${rule.detail})`,
    );
  }
}

for (const line of said) console.log(`  ${line}`);
if (problems.length > 0) {
  console.error("");
  for (const p of problems) console.error(`  x ${p}`);
  process.exit(1);
}
console.log("  ok            this version can be published");
