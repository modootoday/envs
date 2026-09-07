import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryRoot = join(pkgRoot, "registry");

interface Key {
  readonly sensitivity: "secret" | "config";
}

const entries: { template: string; key: string; spec: Key }[] = [];
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".json") && dir !== registryRoot) {
      const body = JSON.parse(readFileSync(full, "utf8")) as {
        keys: Record<string, Key>;
      };
      for (const [key, spec] of Object.entries(body.keys)) {
        entries.push({
          template: relative(registryRoot, full).replace(/\.json$/, ""),
          key,
          spec,
        });
      }
    }
  }
};
walk(registryRoot);

/**
 * "config" is not a label, it is a permission: it stores as level low, and
 * envs build bakes low keys into a browser bundle without asking. So every
 * config key here is this registry telling a stranger that shipping it to a
 * browser is fine, and getting one wrong is the most damaging mistake the
 * registry can make.
 *
 * Named rather than counted, so adding one is a decision somebody made and a
 * slip is a failing test. Measured 20260907: three keys were config that
 * should not have been -- an AWS access key id, a Twilio account SID and a
 * Cloudflare account email, each half of a credential pair.
 */
const BROWSER_SAFE: readonly string[] = [
  "aws/credentials:AWS_REGION",
  "cloudflare/api:CLOUDFLARE_ACCOUNT_ID",
  "datadog/agent:DD_SITE",
  "openai/api:OPENAI_ORG_ID",
  "sentry/node:SENTRY_DSN",
  "sentry/node:SENTRY_ORG",
  "sentry/node:SENTRY_PROJECT",
  "stripe/backend:STRIPE_PUBLISHABLE_KEY",
  "supabase/project:SUPABASE_ANON_KEY",
  "supabase/project:SUPABASE_PUBLISHABLE_KEY",
  "supabase/project:SUPABASE_URL",
  "upstash/redis:UPSTASH_REDIS_REST_URL",
  "vercel/deploy:VERCEL_ORG_ID",
  "vercel/deploy:VERCEL_PROJECT_ID",
];

describe("what this registry calls browser-safe", () => {
  it("finds keys to check", () => {
    // A detector that finds nothing must not pass.
    expect(entries.length).toBeGreaterThan(20);
  });

  it("is exactly the list somebody reviewed", () => {
    const marked = entries
      .filter((entry) => entry.spec.sensitivity === "config")
      .map((entry) => `${entry.template}:${entry.key}`)
      .sort();
    expect(marked).toEqual([...BROWSER_SAFE].sort());
  });

  it("declares one of the two levels for every key", () => {
    const bad = entries
      .filter(
        (entry) =>
          entry.spec.sensitivity !== "secret" &&
          entry.spec.sensitivity !== "config",
      )
      .map((entry) => `${entry.template}:${entry.key}`);
    expect(bad).toEqual([]);
  });

  it("keeps anything named like a secret out of the browser-safe list", () => {
    // A blunt reading of the name, deliberately: it cannot prove a key is safe,
    // but it catches the shape of the mistake that was actually made.
    const suspicious = BROWSER_SAFE.filter((entry) =>
      /(SECRET|_TOKEN|PASSWORD|PRIVATE|ACCESS_KEY)/.test(entry),
    );
    expect(suspicious).toEqual([]);
  });
});
