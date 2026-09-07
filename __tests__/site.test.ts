import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMMANDS } from "../src/commands/index.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(pkgRoot, "docs");
const SITE_URL = "https://envs.build";

const pages: string[] = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".html")) pages.push(full);
  }
};
walk(site);

const urlOf = (file: string): string =>
  `/${relative(site, file).replace(/index\.html$/, "")}`.replace(/\/+$/, "/");

const read = (file: string): string => readFileSync(file, "utf8");

const VOID_TAGS = new Set([
  "meta",
  "link",
  "br",
  "hr",
  "img",
  "input",
  "source",
  "path",
  "rect",
  "circle",
]);

/**
 * The site is a published claim about the tool. When the two drift the page is
 * worse than no page, so the checks run where every other guard runs.
 */
describe("the site a crawler and a reader get", () => {
  it("has the pages it means to have", () => {
    // Named rather than counted: a template page arriving is expected, and a
    // hand-written page disappearing is not.
    expect(pages.map(urlOf).sort()).toEqual([
      "/",
      "/commands/",
      "/compare/",
      "/format/",
      "/guide/",
      "/hosted/",
      "/licence/",
      "/recovery/",
      "/templates/",
      "/templates/anthropic/api/",
      "/templates/aws/credentials/",
      "/templates/cloudflare/api/",
      "/templates/datadog/agent/",
      "/templates/discord/bot/",
      "/templates/github/actions/",
      "/templates/github/api/",
      "/templates/gitlab/api/",
      "/templates/google/gemini/",
      "/templates/mongodb/atlas/",
      "/templates/openai/api/",
      "/templates/postgres/connection/",
      "/templates/redis/connection/",
      "/templates/resend/email/",
      "/templates/sentry/node/",
      "/templates/slack/bot/",
      "/templates/stripe/backend/",
      "/templates/supabase/project/",
      "/templates/twilio/api/",
      "/templates/upstash/redis/",
      "/templates/vercel/deploy/",
    ]);
  });

  it("gives every page a title, description, canonical, og:url and lang", () => {
    const missing: string[] = [];
    for (const file of pages) {
      const html = read(file);
      const url = urlOf(file);
      const need: [string, RegExp][] = [
        ["<title>", /<title>[^<]{10,70}<\/title>/],
        // Whitespace-tolerant: the formatter wraps a long attribute onto its
        // own lines, and a check that matches one layout tests the formatter.
        [
          "meta description",
          /<meta\s+name="description"\s+content="[^"]{50,300}"/s,
        ],
        ["canonical", new RegExp(`rel="canonical" href="${SITE_URL}${url}"`)],
        ["viewport", /name="viewport"/],
        ["lang", /<html lang="en">/],
        ["og:url", new RegExp(`property="og:url" content="${SITE_URL}${url}"`)],
      ];
      for (const [name, pattern] of need) {
        if (!pattern.test(html)) missing.push(`${url}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("closes every tag and wraps every table exactly once", () => {
    const problems: string[] = [];
    for (const file of pages) {
      const html = read(file);
      const stack: string[] = [];
      for (const match of html.matchAll(
        /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g,
      )) {
        const [, closing, name, attrs] = match;
        const tag = (name ?? "").toLowerCase();
        if (tag === "!doctype" || VOID_TAGS.has(tag)) continue;
        if ((attrs ?? "").trimEnd().endsWith("/")) continue;
        if (closing) {
          const open = stack.pop();
          if (open !== tag) {
            problems.push(
              `${urlOf(file)}: </${tag}> closes <${open ?? "nothing"}>`,
            );
          }
        } else stack.push(tag);
      }
      if (stack.length > 0) {
        problems.push(`${urlOf(file)}: unclosed ${stack.join(", ")}`);
      }
      const wrappers = (html.match(/class="scroll"/g) ?? []).length;
      const tables = (html.match(/<table>/g) ?? []).length;
      if (wrappers !== tables) {
        problems.push(
          `${urlOf(file)}: ${wrappers} scroll wrappers for ${tables} tables`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * Paths the hub serves from a different build, mounted beside this site at
   * the same origin. Listed rather than skipped by pattern, so adding one is
   * a decision and a typo is still a dead link.
   */
  const SERVED_ELSEWHERE = new Set(["/account/"]);

  it("has no dead internal link", () => {
    const dead: string[] = [];
    for (const file of pages) {
      for (const match of read(file).matchAll(/href="(\/[^"#]*)"/g)) {
        const href = match[1] ?? "";
        if (SERVED_ELSEWHERE.has(href)) continue;
        const target = href.endsWith("/")
          ? join(site, href, "index.html")
          : join(site, href);
        if (!existsSync(target)) dead.push(`${urlOf(file)} -> ${href}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("keeps that allowance to exactly what was decided", () => {
    // A pattern-shaped exemption would let any typo beneath it pass. This
    // repository cannot see the build that serves these, so the list is the
    // whole of the promise and it stays short enough to read.
    expect([...SERVED_ELSEWHERE].sort()).toEqual(["/account/"]);
  });

  it("carries structured data that parses", () => {
    const kinds = new Set<string>();
    const broken: string[] = [];
    for (const file of pages) {
      for (const match of read(file).matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
      )) {
        try {
          kinds.add(
            (JSON.parse(match[1] ?? "") as { "@type": string })["@type"],
          );
        } catch {
          broken.push(urlOf(file));
        }
      }
    }
    expect(broken).toEqual([]);
    expect([...kinds].sort()).toEqual([
      "FAQPage",
      "HowTo",
      "SoftwareApplication",
    ]);
  });

  it("ships the crawl plumbing a static host needs", () => {
    const sitemap = read(join(site, "sitemap.xml"));
    expect(sitemap).toContain("<urlset");
    expect((sitemap.match(/<loc>/g) ?? []).length).toBe(pages.length);
    expect(read(join(site, "robots.txt"))).toContain("Sitemap:");
    expect(read(join(site, "CNAME")).trim()).toBe("envs.build");
    expect(existsSync(join(site, ".nojekyll"))).toBe(true);
  });
});

describe("the site still describes the tool that exists", () => {
  it("documents every command the registry defines", () => {
    const reference = read(join(site, "commands/index.html"));
    const names = COMMANDS.map((command) => command.name);
    // A detector that finds nothing must not pass.
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names.filter((name) => !reference.includes(`envs ${name}`))).toEqual(
      [],
    );
  });

  it("counts the commands correctly wherever prose counts them", () => {
    // Measured: the README said 21 after three more shipped. A count in prose
    // goes stale silently, because nothing resolves it against the registry.
    const claims: string[] = [];
    for (const file of [...pages, join(pkgRoot, "README.md")]) {
      for (const [, count] of read(file).matchAll(/(\d+)\s+commands\b/g)) {
        claims.push(`${urlOf(file)}: ${count}`);
      }
    }
    expect(claims.length).toBeGreaterThan(0);
    expect(
      claims.filter((claim) => !claim.endsWith(` ${COMMANDS.length}`)),
    ).toEqual([]);
  });

  it("names this package wherever it shows an install line", () => {
    const manifest = JSON.parse(read(join(pkgRoot, "package.json"))) as {
      name: string;
    };
    const wrong: string[] = [];
    for (const file of pages) {
      const html = read(file);
      if (!html.includes("npm install") && !html.includes("npx ")) continue;
      if (!html.includes(manifest.name)) wrong.push(urlOf(file));
    }
    expect(wrong).toEqual([]);
  });

  it("names the licence the manifest declares", () => {
    expect(read(join(site, "licence/index.html"))).toContain(
      "Elastic License 2.0",
    );
  });

  it("gives every page the shell the stylesheet is written for", () => {
    // Measured in a browser 20260907: the generated template pages emitted a
    // bare <header> and no .wrap, so main laid out at x=0 w=1200 while every
    // hand-written page sat in a 640px column. They looked broken on their own,
    // and nothing here noticed because the checks read metadata, not chrome.
    const required: [string, RegExp][] = [
      ["skip link", /<a class="skip" href="#main">/],
      ["site header", /<header class="site">/],
      ["brand mark", /<a class="brand" href="\/">/],
      ["main is the wrap", /<main id="main" class="wrap">/],
      ["site footer", /<footer class="site">/],
    ];
    const missing: string[] = [];
    for (const file of pages) {
      const html = read(file);
      for (const [what, pattern] of required) {
        if (!pattern.test(html)) missing.push(`${urlOf(file)}: ${what}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("carries the same six at the top and the whole map at the bottom", () => {
    // The header is for choosing and the footer is for finding, so a page kept
    // out of the header must still be in the footer or it is orphaned. Measured
    // 20260907: /recovery/ had zero prose links in, so the footer is the only
    // thing standing between it and nobody.
    const inside = (html: string, tag: string): string[] => {
      const open = html.indexOf(`<${tag} class="site">`);
      const nav = html.indexOf("<nav>", open);
      const end = html.indexOf("</nav>", nav);
      return [...html.slice(nav, end).matchAll(/href="([^"]+)"/g)].map(
        (m) => m[1] ?? "",
      );
    };
    const HEADER = [
      "/guide/",
      "/templates/",
      "/hosted/",
      "/format/",
      "/compare/",
      "/commands/",
    ];
    const FOOTER = [
      ...HEADER.slice(0, 4),
      "/recovery/",
      ...HEADER.slice(4),
      "/licence/",
    ];
    const wrong: string[] = [];
    for (const file of pages) {
      const html = read(file);
      const head = inside(html, "header");
      const foot = inside(html, "footer");
      if (head.join(",") !== HEADER.join(",")) {
        wrong.push(`${urlOf(file)} header: ${head.join(" ")}`);
      }
      if (foot.join(",") !== FOOTER.join(",")) {
        wrong.push(`${urlOf(file)} footer: ${foot.join(" ")}`);
      }
    }
    expect(wrong).toEqual([]);
    // Every page the site has is reachable from the footer, or named as a
    // template page which the templates index lists.
    for (const file of pages) {
      const url = urlOf(file);
      const listed =
        FOOTER.includes(url) || url === "/" || url.startsWith("/templates/");
      expect([url, listed]).toEqual([url, true]);
    }
  });

  it("reaches the paid page from the prose, not only from the nav", () => {
    // Measured 20260907: every free page carried the nav link and zero body
    // links, so the menu was holding the whole commercial half on its own. A
    // reader following the prose never arrived. Counted inside <main> for
    // exactly that reason -- the shared nav must not answer for the writing.
    const inMain = (text: string): string =>
      text.slice(text.indexOf("<main"), text.indexOf("</main>"));
    const reached = pages
      .filter((file) => !urlOf(file).startsWith("/hosted/"))
      .filter((file) => /href="\/hosted\//.test(inMain(read(file))))
      .map(urlOf)
      .sort();
    // Named, not counted: a page dropping out must fail rather than be
    // absorbed by another page gaining one.
    expect(reached).toEqual(["/", "/commands/", "/compare/", "/guide/"]);
  });

  it("is written in English and quotes no local path", () => {
    const offenders: string[] = [];
    for (const file of [
      ...pages,
      join(site, "robots.txt"),
      join(site, "sitemap.xml"),
    ]) {
      const text = read(file);
      // Bounds escaped, not literal: one of them is a non-breaking space,
      // and a character nobody can see in a regex is one nobody reviews.
      if (/[^\p{ASCII}\u2010-\u203A\u00A0-\u00FF]/u.test(text)) {
        offenders.push(`${relative(site, file)}: non-Latin text`);
      }
      if (/(?:^|[\s"'(])\/(?:home|Users)\//.test(text)) {
        offenders.push(`${relative(site, file)}: absolute local path`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
