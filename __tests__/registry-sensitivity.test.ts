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
  "adyen/payments:ADYEN_CLIENT_KEY",
  "algolia/search:ALGOLIA_APP_ID",
  "algolia/search:ALGOLIA_SEARCH_API_KEY",
  "auth0/app:APP_BASE_URL",
  "auth0/app:AUTH0_CLIENT_ID",
  "auth0/app:AUTH0_DOMAIN",
  "aws/credentials:AWS_REGION",
  "axiom/api:AXIOM_ORG_ID",
  "axiom/api:AXIOM_URL",
  "bugsnag/errors:BUGSNAG_API_KEY",
  "clerk/auth:NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "cloudflare/api:CLOUDFLARE_ACCOUNT_ID",
  "contentful/delivery:CONTENTFUL_DELIVERY_TOKEN",
  "contentful/delivery:CONTENTFUL_SPACE_ID",
  "datadog/agent:DD_SITE",
  "directus/api:DIRECTUS_URL",
  "ghost/content:GHOST_API_URL",
  "ghost/content:GHOST_CONTENT_API_KEY",
  "honeycomb/otel:OTEL_EXPORTER_OTLP_ENDPOINT",
  "honeycomb/otel:OTEL_SERVICE_NAME",
  "launchdarkly/flags:LAUNCHDARKLY_CLIENT_SIDE_ID",
  "launchdarkly/flags:LAUNCHDARKLY_MOBILE_KEY",
  "meilisearch/server:MEILI_SEARCH_KEY",
  "openai/api:OPENAI_ORG_ID",
  "paddle/billing:PADDLE_CLIENT_TOKEN",
  "paypal/api:PAYPAL_CLIENT_ID",
  "posthog/analytics:NEXT_PUBLIC_POSTHOG_HOST",
  "posthog/analytics:NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
  "pusher/channels:PUSHER_CLUSTER",
  "pusher/channels:PUSHER_KEY",
  "recurly/api:RECURLY_PUBLIC_KEY",
  "rollbar/errors:ROLLBAR_CLIENT_TOKEN",
  "sanity/project:SANITY_DATASET",
  "sanity/project:SANITY_PROJECT_ID",
  "sentry/node:SENTRY_DSN",
  "sentry/node:SENTRY_ORG",
  "sentry/node:SENTRY_PROJECT",
  "shopify/app:SHOPIFY_STOREFRONT_ACCESS_TOKEN",
  "square/payments:SQ_APPLICATION_ID",
  "storyblok/delivery:STORYBLOK_PUBLIC_TOKEN",
  "stripe/backend:STRIPE_PUBLISHABLE_KEY",
  "supabase/project:SUPABASE_ANON_KEY",
  "supabase/project:SUPABASE_PUBLISHABLE_KEY",
  "supabase/project:SUPABASE_URL",
  "typesense/search:TYPESENSE_SEARCH_ONLY_API_KEY",
  "upstash/redis:UPSTASH_REDIS_REST_URL",
  "vercel/deploy:VERCEL_ORG_ID",
  "vercel/deploy:VERCEL_PROJECT_ID",
];

/**
 * Named exceptions to the name check below, for providers that call a public
 * credential a token. Each is admitted on the provider's own sentence, not on
 * the name reading harmlessly to us.
 *
 * PostHog: the project token is public and safe in client-side code.
 * Paddle: client-side tokens are safe to publish and expose in your code.
 * Shopify: the public Storefront token is for client side queries, and the
 * private one is the token Shopify says to keep off the client.
 * Contentful: delivery tokens are safe for client-side use, being read-only
 * over published content, while the preview and management tokens are not.
 * Storyblok: the public token is for production frontends.
 * Rollbar: the client token can only send events, only from a client-side
 * platform, cannot read data and cannot spoof a server event.
 */
const ALLOWED_DESPITE_NAME: readonly string[] = [
  "contentful/delivery:CONTENTFUL_DELIVERY_TOKEN",
  "paddle/billing:PADDLE_CLIENT_TOKEN",
  "rollbar/errors:ROLLBAR_CLIENT_TOKEN",
  "posthog/analytics:NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
  "shopify/app:SHOPIFY_STOREFRONT_ACCESS_TOKEN",
  "storyblok/delivery:STORYBLOK_PUBLIC_TOKEN",
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
    // but it catches the shape of the mistake that was actually made. An
    // exception is a named decision, so a provider whose public key is called
    // a token costs one line here rather than weakening the rule for everyone.
    const suspicious = BROWSER_SAFE.filter(
      (entry) =>
        /(SECRET|_TOKEN|PASSWORD|PRIVATE|ACCESS_KEY)/.test(entry) &&
        !ALLOWED_DESPITE_NAME.includes(entry),
    );
    expect(suspicious).toEqual([]);
  });

  it("holds no exception for a key that is no longer browser-safe", () => {
    // Otherwise a key demoted to secret leaves its exception standing, and the
    // next key to take that name inherits a decision nobody made for it.
    const stale = ALLOWED_DESPITE_NAME.filter(
      (entry) => !BROWSER_SAFE.includes(entry),
    );
    expect(stale).toEqual([]);
  });
});
