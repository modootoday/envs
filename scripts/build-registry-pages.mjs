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

/**
 * The site chrome, lifted out of a hand-written page rather than written again
 * here. The stylesheet targets header.site, .wrap and a.brand, so a generated
 * page that emits a bare <header> lands full-bleed and unstyled beside pages
 * that do not -- measured in a browser: main at x=0 w=1200 against x=280 w=640.
 */
// Six at the top, the whole map at the bottom: the header is for choosing and
// the footer is for finding, so a page dropped from the header is not orphaned.
const HEADER_NAV = [
  ["/guide/", "Start"],
  ["/templates/", "Templates"],
  ["/hosted/", "Hosted"],
  ["/format/", "Format"],
  ["/compare/", "Compare"],
  ["/commands/", "Commands"],
];

const FOOTER_NAV = [
  ["/guide/", "Start"],
  ["/templates/", "Templates"],
  ["/hosted/", "Hosted"],
  ["/format/", "Format"],
  ["/recovery/", "Recovery"],
  ["/compare/", "Compare"],
  ["/commands/", "Commands"],
  ["/licence/", "Licence"],
];

const navLinks = (items, current, indent) =>
  items
    .map(
      ([href, text]) =>
        `${indent}<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${text}</a>`,
    )
    .join("\n");

const MARK = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="0.75" y="0.75" width="16.5" height="16.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M4.6 6.2 7.2 9l-2.6 2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M9.4 11.9h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>`;

const shellTop = (
  current,
) => `    <a class="skip" href="#main">Skip to content</a>

    <header class="site">
      <div class="wrap">
        <a class="brand" href="/">
          ${MARK}
          envs
        </a>
        <nav>
${navLinks(HEADER_NAV, current, "          ")}
        </nav>
      </div>
    </header>

    <main id="main" class="wrap">`;

const shellBottom = (current) => `    </main>

    <footer class="site">
      <div class="wrap">
        <nav>
${navLinks(FOOTER_NAV, current, "          ")}
        </nav>
        <p>
          Copyright &copy; 2026 modootoday. Licensed under the Elastic License
          2.0.
        </p>
      </div>
    </footer>`;

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    // namespaces.json sits at the root and is the allowlist, not a template.
    else if (entry.endsWith(".json") && dir !== registry) files.push(full);
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
      if (spec.pattern)
        notes.push(`Shape <code>${escape(spec.pattern)}</code>`);
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
${shellTop("/templates/")}
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
${shellBottom("/templates/")}
  </body>
</html>
`;
};

// Published beside the templates it vouches for: a CLI checks an obtain link
// against the registry that served the template, so a provider arriving needs
// no new release of the CLI.
const namespacesFile = join(registry, "namespaces.json");
put(join(docs, "v1", "namespaces.json"), readFileSync(namespacesFile, "utf8"));

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

// Categories come from the registry, keyed on the template rather than its
// namespace: one namespace can hold templates from two domains, and grouping
// by namespace filed a model API under maps. A template in no category would
// vanish from this page, which __tests__/registry-category.test.ts refuses.
const categories = JSON.parse(readFileSync(namespacesFile, "utf8")).categories;

const row = ({ name, template }) => {
  const specs = Object.values(template.keys);
  const open = specs.filter((spec) => spec.sensitivity === "config").length;
  return `              <tr>
                <td><a href="/templates/${name}/"><code>${escape(name)}</code></a></td>
                <td>${escape(template.title)}</td>
                <td>${String(specs.length)}</td>
                <td>${open === 0 ? "&mdash;" : String(open)}</td>
              </tr>`;
};

const section = ({ label, templates }) => {
  const rows = listed
    .filter((entry) => templates.includes(entry.name))
    .map(row)
    .join("\n");
  return `      <section>
        <h2>${escape(label)}</h2>
        <div class="scroll">
          <table>
            <thead>
              <tr><th>Template</th><th>What it covers</th><th>Keys</th><th>Browser-safe</th></tr>
            </thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>
      </section>`;
};

const services = new Set(listed.map((entry) => entry.name.split("/")[0]));
const summary = `${String(listed.length)} templates across ${String(services.size)} services`;

const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Templates — envs</title>
    <meta
      name="description"
      content="Schemas for the keys a service needs, grouped by what they do. No values, ever."
    />
    <link rel="canonical" href="https://envs.build/templates/" />
    <meta property="og:title" content="Templates — envs" />
    <meta property="og:url" content="https://envs.build/templates/" />
    <meta
      property="og:description"
      content="Schemas for the keys a service needs, grouped by what they do. No values, ever."
    />
    <link rel="stylesheet" href="/assets/style.css" />
  </head>
  <body>
${shellTop("/templates/")}
      <h1>Templates</h1>
      <p>
        A template says which keys a service needs and what each one should
        look like. It never carries a value, which is the only reason a public
        list of these can exist. The last column counts the keys a provider
        states may be published, such as a publishable key or a search-only
        key; the rest belong on your server.
      </p>
      <div class="filter" hidden>
        <label for="q">Find a service</label>
        <input id="q" type="search" autocomplete="off" placeholder="stripe, postgres, sentry" />
        <p class="count" role="status">${summary}</p>
      </div>
      <p class="count-plain">${summary}.</p>
${categories.map(section).join("\n")}
      <p id="empty" hidden>Nothing here matches that. Try the service's own name.</p>
      <p>
        Missing one? Publishing is a pull request, and every template is checked
        with <code>envs template lint</code> before it merges.
      </p>
      <script src="/assets/templates.js" defer></script>
${shellBottom("/templates/")}
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
// No lastmod. Stamped from the clock it differs from the committed file every
// day; frozen by hand it says a page has not changed when it has. The protocol
// makes it optional and a crawler discards one it cannot trust, so a date
// nobody maintains is worse than none.
put(
  join(docs, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (url) => `  <url>
    <loc>https://envs.build${url}</loc>
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
