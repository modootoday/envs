#!/usr/bin/env node
/**
 * Renders the registry into the two surfaces the site serves: JSON for the
 * CLI and a page for a person. Both are static files, so the marketplace
 * needs no server.
 *
 * Run: node scripts/build-registry-pages.mjs [--check]
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = join(root, "registry");
const docs = join(root, "docs");
const check = process.argv.includes("--check");

const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith(".json")) files.push(full);
  }
};
walk(registry);
files.sort();

const written = new Map();
const put = (path, body) => written.set(path, body);

const page = (template, name) => {
  const rows = Object.entries(template.keys)
    .map(([key, spec]) => {
      const notes = [];
      if (spec.description) notes.push(escape(spec.description));
      if (spec.pattern) notes.push(`Shape <code>${escape(spec.pattern)}</code>`);
      if (spec.rotateDays)
        notes.push(`Rotate every ${String(spec.rotateDays)} days`);
      const where = spec.obtain
        ? `<a href="${escape(spec.obtain)}" rel="nofollow noopener">where to get it</a>`
        : "";
      return `            <tr>
              <td><code>${escape(key)}</code></td>
              <td>${spec.required ? "required" : "optional"}</td>
              <td>${spec.sensitivity === "secret" ? "secret" : "config"}</td>
              <td>${notes.join(". ")}${notes.length && where ? ". " : ""}${where}</td>
            </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(template.title)} — envs</title>
    <meta
      name="description"
      content="The keys ${escape(name)} needs, as a schema. No values, ever."
    />
    <link rel="canonical" href="https://envs.build/templates/${name}/" />
    <meta property="og:title" content="${escape(template.title)} — envs" />
    <meta property="og:url" content="https://envs.build/templates/${name}/" />
    <meta
      property="og:description"
      content="The keys ${escape(name)} needs, as a schema. No values, ever."
    />
    <link rel="stylesheet" href="/assets/style.css" />
  </head>
  <body>
    <header>
      <a href="/">envs</a>
      <nav><a href="/templates/">templates</a> <a href="/commands/">commands</a></nav>
    </header>
    <main>
      <h1>${escape(template.title)}</h1>
      <p><code>${escape(name)}</code> · version ${String(template.version)}</p>
      <pre><code>envs add ${escape(name)}</code></pre>
      <p>
        This declares the keys below in your catalog and sets none of them. A
        template is a schema for keys; it never carries a value.
      </p>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Needed</th>
              <th>Kind</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
      <p><a href="/v1/templates/${name}.json">The JSON the CLI reads</a></p>
    </main>
  </body>
</html>
`;
};

const listed = [];
for (const file of files) {
  const payload = readFileSync(file, "utf8");
  const template = JSON.parse(payload);
  const name = relative(registry, file).replace(/\.json$/, "");
  // Byte-for-byte, so the digest a catalog records matches what was reviewed.
  put(join(docs, "v1", "templates", `${name}.json`), payload);
  put(join(docs, "templates", name, "index.html"), page(template, name));
  listed.push({ name, template });
}

const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Templates — envs</title>
    <meta
      name="description"
      content="Schemas for the keys a service needs. No values, ever."
    />
    <link rel="canonical" href="https://envs.build/templates/" />
    <meta property="og:title" content="Templates — envs" />
    <meta property="og:url" content="https://envs.build/templates/" />
    <meta
      property="og:description"
      content="Schemas for the keys a service needs. No values, ever."
    />
    <link rel="stylesheet" href="/assets/style.css" />
  </head>
  <body>
    <header>
      <a href="/">envs</a>
      <nav><a href="/templates/">templates</a> <a href="/commands/">commands</a></nav>
    </header>
    <main>
      <h1>Templates</h1>
      <p>
        A template says which keys a service needs and what each one should
        look like. It never carries a value, which is the only reason a public
        list of these can exist.
      </p>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Template</th><th>What it covers</th><th>Keys</th></tr>
          </thead>
          <tbody>
${listed
  .map(
    ({ name, template }) => `            <tr>
              <td><a href="/templates/${name}/"><code>${escape(name)}</code></a></td>
              <td>${escape(template.title)}</td>
              <td>${String(Object.keys(template.keys).length)}</td>
            </tr>`,
  )
  .join("\n")}
          </tbody>
        </table>
      </div>
      <p>
        Publishing is a pull request, and every template is checked with
        <code>envs template lint</code> before it merges.
      </p>
    </main>
  </body>
</html>
`;
put(join(docs, "templates", "index.html"), index);

// The sitemap is written here too: a page a crawler cannot find is a page
// that was not published, and hand-listing them drifts the moment one is added.
const allPages = [];
const collect = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full);
    else if (entry === "index.html") allPages.push(full);
  }
};
collect(docs);
for (const path of written.keys()) {
  if (path.endsWith("index.html") && !allPages.includes(path)) {
    allPages.push(path);
  }
}
const urls = [
  ...new Set(
    allPages.map((file) =>
      `/${relative(docs, file).replace(/index\.html$/, "")}`.replace(
        /\/+$/,
        "/",
      ),
    ),
  ),
].sort((a, b) => a.length - b.length || a.localeCompare(b));
// A date a URL already carries is kept. Stamping today's on every run makes
// the output differ from the committed file every day, so the drift check
// fails on the calendar rather than on a change anybody made.
const previous = new Map();
try {
  const existing = readFileSync(join(docs, "sitemap.xml"), "utf8");
  for (const block of existing.split("<url>").slice(1)) {
    const loc = /<loc>https:\/\/envs\.build([^<]*)<\/loc>/.exec(block)?.[1];
    const seen = /<lastmod>([^<]*)<\/lastmod>/.exec(block)?.[1];
    if (loc && seen) previous.set(loc, seen);
  }
} catch {
  /* first run */
}
const today = new Date().toISOString().slice(0, 10);
put(
  join(docs, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (url) => `  <url>
    <loc>https://envs.build${url}</loc>
    <lastmod>${previous.get(url) ?? today}</lastmod>
    <priority>${url === "/" ? "1.0" : "0.8"}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>
`,
);

let stale = 0;
for (const [path, body] of written) {
  let current = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }
  if (current === body) continue;
  stale += 1;
  if (check) {
    console.error(`stale: ${relative(root, path)}`);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// A page for a template that is gone would keep answering after its removal.
const generatedRoots = [join(docs, "v1", "templates"), join(docs, "templates")];
for (const dir of generatedRoots) {
  let entries = [];
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    if (written.has(full)) continue;
    stale += 1;
    if (check) console.error(`orphan: ${relative(root, full)}`);
    else rmSync(full);
  }
}

if (check && stale > 0) {
  console.error(`${String(stale)} file(s) out of date; run without --check`);
  process.exit(1);
}
console.log(
  check
    ? `registry pages are current (${String(written.size)} files)`
    : `wrote ${String(written.size)} files`,
);
