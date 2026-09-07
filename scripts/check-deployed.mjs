#!/usr/bin/env node
/**
 * Compares what the site serves against what was built.
 *
 * The pages pass through a CDN that rewrites HTML, and one of those rewrites
 * read every "package@version" as an email address and replaced the version a
 * skill was verified against with an obfuscation link. Nothing in a build or a
 * unit test can see that: the bytes only differ once served.
 *
 * Run: node scripts/check-deployed.mjs [--site https://envs.build]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");

const flag = process.argv.indexOf("--site");
const site = flag < 0 ? "https://envs.build" : process.argv[flag + 1];
if (!site) throw new Error("--site needs a base URL");

function routes() {
  const found = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "_site" || name === "node_modules") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "index.html") {
        const parent = relative(docs, dir);
        found.set(
          parent === "" ? "/" : `/${parent.split("\\").join("/")}/`,
          path,
        );
      }
    }
  };
  walk(docs);
  return found;
}

/**
 * The pages carry no external script of their own, so any of them in a served
 * page came from the edge. Those are removed before comparing and reported
 * separately: an appended analytics tag is a different thing from a rewrite of
 * the content, and folding them together would hide the second.
 *
 * That premise is measured, not assumed. Measured 20260907 across this site:
 * zero pages match <script src="http…">, and the only script tags are six
 * inline JSON-LD blocks. If a page ever loads one of its own, this rule stops
 * being sound and the fix is a way to tell ours from theirs, not an allowlist.
 */
const EXTERNAL_SCRIPT =
  /<script\b[^>]*\bsrc="https?:\/\/[^"]*"[^>]*>\s*<\/script>\n?/giu;

function withoutInjectedScripts(html) {
  const sources = [...html.matchAll(EXTERNAL_SCRIPT)]
    .map((match) => /src="([^"]*)"/u.exec(match[0])?.[1])
    .filter((source) => source !== undefined);
  return { html: html.replace(EXTERNAL_SCRIPT, ""), sources };
}

const differing = [];
const reformatted = [];
const missing = [];
const injectedBy = new Map();
let checked = 0;

for (const [route, file] of [...routes()].sort()) {
  const expected = readFileSync(file, "utf8");
  let served;
  try {
    const response = await fetch(new URL(route, site), {
      headers: { "cache-control": "no-cache", accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      missing.push({ route, status: response.status });
      continue;
    }
    served = await response.text();
  } catch (cause) {
    missing.push({ route, status: String(cause) });
    continue;
  }
  checked += 1;
  const cleaned = withoutInjectedScripts(served);
  for (const source of cleaned.sources) {
    injectedBy.set(source, (injectedBy.get(source) ?? 0) + 1);
  }
  served = cleaned.html;
  if (served === expected) continue;
  // Report the first divergence rather than the whole file: a rewrite shows up
  // as one substitution, and a diff of two full pages hides it.
  let at = 0;
  while (
    at < served.length &&
    at < expected.length &&
    served[at] === expected[at]
  )
    at += 1;
  const divergence = {
    route,
    at,
    expected: expected.slice(at, at + 90),
    served: served.slice(at, at + 90),
  };
  // An edge that reindents the page is not an edge that changed what it says.
  // Only the second is a defect, and folding them together would train a
  // reader to ignore the first failure they see.
  const squeeze = (html) => html.replace(/\s+/gu, " ").trim();
  if (squeeze(served) === squeeze(expected)) reformatted.push(divergence);
  else differing.push(divergence);
}

const report = {
  site,
  checked,
  differing,
  reformatted,
  missing,
  injected: [...injectedBy].map(([source, pages]) => ({ source, pages })),
};
console.log(JSON.stringify(report, null, 2));
if (differing.length > 0 || missing.length > 0) process.exitCode = 1;
