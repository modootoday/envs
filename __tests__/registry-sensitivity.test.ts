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
  "agora/rtc:AGORA_APP_ID",
  "algolia/search:ALGOLIA_APP_ID",
  "algolia/search:ALGOLIA_SEARCH_API_KEY",
  "amplitude/analytics:AMPLITUDE_API_KEY",
  "auth0/app:APP_BASE_URL",
  "auth0/app:AUTH0_CLIENT_ID",
  "auth0/app:AUTH0_DOMAIN",
  "aws/credentials:AWS_REGION",
  "axiom/api:AXIOM_ORG_ID",
  "axiom/api:AXIOM_URL",
  "azure/playwright:PLAYWRIGHT_SERVICE_URL",
  "bugsnag/errors:BUGSNAG_API_KEY",
  "checkly/cli:CHECKLY_ACCOUNT_ID",
  "chroma/cloud:CHROMA_DATABASE",
  "chroma/cloud:CHROMA_HOST",
  "chroma/cloud:CHROMA_TENANT",
  "clerk/auth:NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "cloudflare/api:CLOUDFLARE_ACCOUNT_ID",
  "cloudinary/media:CLOUDINARY_API_KEY",
  "cloudinary/media:CLOUDINARY_CLOUD_NAME",
  "contentful/delivery:CONTENTFUL_DELIVERY_TOKEN",
  "contentful/delivery:CONTENTFUL_SPACE_ID",
  "crisp/chat:CRISP_WEBSITE_ID",
  "cypress/cloud:CYPRESS_PROJECT_ID",
  "databricks/api:DATABRICKS_ACCOUNT_ID",
  "databricks/api:DATABRICKS_HOST",
  "datadog/agent:DD_SITE",
  "directus/api:DIRECTUS_URL",
  "doppler/cli:DOPPLER_CONFIG",
  "doppler/cli:DOPPLER_PROJECT",
  "firebase/web:FIREBASE_API_KEY",
  "firebase/web:FIREBASE_APP_ID",
  "firebase/web:FIREBASE_AUTH_DOMAIN",
  "firebase/web:FIREBASE_MESSAGING_SENDER_ID",
  "firebase/web:FIREBASE_PROJECT_ID",
  "firebase/web:FIREBASE_STORAGE_BUCKET",
  "fusionauth/api:FUSIONAUTH_URL",
  "getstream/chat:STREAM_API_KEY",
  "ghost/content:GHOST_API_URL",
  "ghost/content:GHOST_CONTENT_API_KEY",
  "honeycomb/otel:OTEL_EXPORTER_OTLP_ENDPOINT",
  "honeycomb/otel:OTEL_SERVICE_NAME",
  "hubspot/api:HUBSPOT_HUB_ID",
  "imagekit/media:IMAGEKIT_PUBLIC_KEY",
  "imagekit/media:IMAGEKIT_URL_ENDPOINT",
  "infisical/cli:INFISICAL_API_URL",
  "infisical/cli:INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
  "influxdb/v3:INFLUXDB3_DATABASE_NAME",
  "influxdb/v3:INFLUXDB3_HOST_URL",
  "intercom/api:INTERCOM_APP_ID",
  "jira/api:JIRA_BASE_URL",
  "kinde/auth:KINDE_ISSUER_URL",
  "kinde/auth:KINDE_POST_LOGIN_REDIRECT_URL",
  "kinde/auth:KINDE_POST_LOGOUT_REDIRECT_URL",
  "kinde/auth:KINDE_SITE_URL",
  "klaviyo/api:KLAVIYO_PUBLIC_API_KEY",
  "knock/notifications:KNOCK_PUBLIC_KEY",
  "langfuse/tracing:LANGFUSE_BASE_URL",
  "langfuse/tracing:LANGFUSE_PUBLIC_KEY",
  "launchdarkly/flags:LAUNCHDARKLY_CLIENT_SIDE_ID",
  "launchdarkly/flags:LAUNCHDARKLY_MOBILE_KEY",
  "livekit/realtime:LIVEKIT_URL",
  "mailgun/email:MAILGUN_DOMAIN",
  "mapbox/maps:MAPBOX_ACCESS_TOKEN",
  "meilisearch/server:MEILI_SEARCH_KEY",
  "milvus/server:MILVUS_URI",
  "mixpanel/analytics:MIXPANEL_TOKEN",
  "okta/app:OKTA_CLIENT_ORGURL",
  "onesignal/push:ONESIGNAL_APP_ID",
  "openai/api:OPENAI_ORG_ID",
  "oracle/cli:OCI_CLI_REGION",
  "ory/network:ORY_SDK_URL",
  "ovh/api:OVH_ENDPOINT",
  "paddle/billing:PADDLE_CLIENT_TOKEN",
  "paypal/api:PAYPAL_CLIENT_ID",
  "posthog/analytics:NEXT_PUBLIC_POSTHOG_HOST",
  "posthog/analytics:NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
  "pusher/channels:PUSHER_CLUSTER",
  "pusher/channels:PUSHER_KEY",
  "qdrant/cloud:QDRANT_URL",
  "radar/location:RADAR_PUBLISHABLE_KEY",
  "recurly/api:RECURLY_PUBLIC_KEY",
  "rollbar/errors:ROLLBAR_CLIENT_TOKEN",
  "salesforce/api:SALESFORCE_INSTANCE_URL",
  "sanity/project:SANITY_DATASET",
  "sanity/project:SANITY_PROJECT_ID",
  "scaleway/api:SCW_DEFAULT_ORGANIZATION_ID",
  "scaleway/api:SCW_DEFAULT_PROJECT_ID",
  "scaleway/api:SCW_DEFAULT_REGION",
  "scaleway/api:SCW_DEFAULT_ZONE",
  "segment/analytics:SEGMENT_WRITE_KEY",
  "sentry/cli:SENTRY_ORG",
  "sentry/cli:SENTRY_PROJECT",
  "sentry/node:SENTRY_DSN",
  "sentry/node:SENTRY_ORG",
  "sentry/node:SENTRY_PROJECT",
  "shopify/app:SHOPIFY_STOREFRONT_ACCESS_TOKEN",
  "sinch/api:SINCH_KEY_ID",
  "snowflake/cli:SNOWFLAKE_ACCOUNT",
  "spacelift/api:SPACELIFT_API_KEY_ENDPOINT",
  "square/payments:SQ_APPLICATION_ID",
  "storyblok/delivery:STORYBLOK_PUBLIC_TOKEN",
  "stripe/backend:STRIPE_PUBLISHABLE_KEY",
  "stytch/auth:STYTCH_PUBLIC_TOKEN",
  "supabase/project:SUPABASE_ANON_KEY",
  "supabase/project:SUPABASE_PUBLISHABLE_KEY",
  "supabase/project:SUPABASE_URL",
  "supertokens/core:SUPERTOKENS_CONNECTION_URI",
  "surrealdb/server:SURREAL_AUTH_LEVEL",
  "surrealdb/server:SURREAL_DATABASE",
  "surrealdb/server:SURREAL_NAMESPACE",
  "turso/database:TURSO_ORG",
  "typesense/search:TYPESENSE_SEARCH_ONLY_API_KEY",
  "upstash/redis:UPSTASH_REDIS_REST_URL",
  "vault/server:VAULT_ADDR",
  "vault/server:VAULT_NAMESPACE",
  "vercel/deploy:VERCEL_ORG_ID",
  "vercel/deploy:VERCEL_PROJECT_ID",
  "weaviate/cloud:WEAVIATE_URL",
  "zoho/crm:ZOHO_API_DOMAIN",
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
 * Mixpanel: a project token is not a secret value and not a form of
 * authorization, and the browser library shows it to every visitor.
 * Stytch: the frontend SDKs use the public token rather than the project id
 * and secret, which is a direction to put this one in the browser.
 * Mapbox: public tokens are designed for client-side applications and can be
 * safely exposed in browsers and mobile apps.
 */
const ALLOWED_DESPITE_NAME: readonly string[] = [
  "contentful/delivery:CONTENTFUL_DELIVERY_TOKEN",
  "mapbox/maps:MAPBOX_ACCESS_TOKEN",
  "mixpanel/analytics:MIXPANEL_TOKEN",
  "paddle/billing:PADDLE_CLIENT_TOKEN",
  "posthog/analytics:NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
  "rollbar/errors:ROLLBAR_CLIENT_TOKEN",
  "shopify/app:SHOPIFY_STOREFRONT_ACCESS_TOKEN",
  "storyblok/delivery:STORYBLOK_PUBLIC_TOKEN",
  "stytch/auth:STYTCH_PUBLIC_TOKEN",
];

describe("what this registry calls browser-safe", () => {
  it("finds keys to check", () => {
    // A detector that finds nothing must not pass.
    expect(entries.length).toBeGreaterThan(20);
  });

  it("reaches every template, not most of them", () => {
    // The floor above stops passing on zero but not on a walk that quietly
    // skips a directory, which at this size would still leave it well over.
    // Enumerated by Node rather than by the recursion at the top of this file,
    // so a bug in that walk cannot agree with itself here.
    const onDisk = readdirSync(registryRoot, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".json") && name.includes("/"))
      .map((name) => name.replace(/\.json$/, ""));
    const walked = [...new Set(entries.map((entry) => entry.template))];
    expect(walked.sort()).toEqual(onDisk.sort());
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
