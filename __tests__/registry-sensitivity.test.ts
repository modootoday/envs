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
  "activecampaign/api:ACTIVECAMPAIGN_API_URL",
  "adyen/payments:ADYEN_CLIENT_KEY",
  "agora/rtc:AGORA_APP_ID",
  "airbrake/errors:AIRBRAKE_PROJECT_ID",
  "airbrake/errors:AIRBRAKE_PROJECT_KEY",
  "algolia/search:ALGOLIA_APP_ID",
  "algolia/search:ALGOLIA_SEARCH_API_KEY",
  "allure/testops:ALLURE_ENDPOINT",
  "amplitude/analytics:AMPLITUDE_API_KEY",
  "arangodb/oasis:ARANGO_URL",
  "arize/observability:ARIZE_SPACE_ID",
  "astra/database:ASTRA_DB_API_ENDPOINT",
  "auth0/app:APP_BASE_URL",
  "auth0/app:AUTH0_CLIENT_ID",
  "auth0/app:AUTH0_DOMAIN",
  "authjs/session:AUTH_URL",
  "aws/credentials:AWS_REGION",
  "axiom/api:AXIOM_ORG_ID",
  "axiom/api:AXIOM_URL",
  "azure/playwright:PLAYWRIGHT_SERVICE_URL",
  "azuredevops/api:AZURE_DEVOPS_ORG_URL",
  "azurekeyvault/access:AZURE_KEY_VAULT_URL",
  "bandwidth/api:BANDWIDTH_ACCOUNT_ID",
  "basecamp/api:BASECAMP_ACCOUNT_ID",
  "beehiiv/api:BEEHIIV_PUBLICATION_ID",
  "bigcommerce/api:BIGCOMMERCE_STOREFRONT_API_TOKEN",
  "bucket/flags:BUCKET_PUBLISHABLE_KEY",
  "bugsnag/errors:BUGSNAG_API_KEY",
  "builderio/api:BUILDER_PUBLIC_API_KEY",
  "bytescale/api:BYTESCALE_ACCOUNT_ID",
  "chatwoot/api:CHATWOOT_BASE_URL",
  "checkly/cli:CHECKLY_ACCOUNT_ID",
  "checkout/payments:CHECKOUT_PUBLIC_KEY",
  "chroma/cloud:CHROMA_DATABASE",
  "chroma/cloud:CHROMA_HOST",
  "chroma/cloud:CHROMA_TENANT",
  "clarity/analytics:CLARITY_PROJECT_ID",
  "clearml/tracking:CLEARML_API_HOST",
  "clerk/auth:NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "cloudflare/api:CLOUDFLARE_ACCOUNT_ID",
  "cloudflarepages/deploy:CLOUDFLARE_PAGES_PROJECT",
  "cloudinary/media:CLOUDINARY_API_KEY",
  "cloudinary/media:CLOUDINARY_CLOUD_NAME",
  "cognito/pool:COGNITO_CLIENT_ID",
  "cognito/pool:COGNITO_USER_POOL_ID",
  "comet/tracking:COMET_WORKSPACE",
  "commercelayer/channel:COMMERCELAYER_CLIENT_ID",
  "configcat/flags:CONFIGCAT_SDK_KEY",
  "contentful/delivery:CONTENTFUL_DELIVERY_TOKEN",
  "contentful/delivery:CONTENTFUL_SPACE_ID",
  "contentsquare/analytics:CONTENTSQUARE_PROJECT_ID",
  "contentstack/delivery:CONTENTSTACK_API_KEY",
  "contentstack/delivery:CONTENTSTACK_DELIVERY_TOKEN",
  "coolify/api:COOLIFY_URL",
  "coralogix/logs:CORALOGIX_DOMAIN",
  "corbado/auth:CORBADO_PROJECT_ID",
  "couchbase/capella:COUCHBASE_CONNECTION_STRING",
  "countly/analytics:COUNTLY_APP_KEY",
  "countly/analytics:COUNTLY_URL",
  "crisp/chat:CRISP_WEBSITE_ID",
  "currents/api:CURRENTS_PROJECT_ID",
  "cypress/cloud:CYPRESS_PROJECT_ID",
  "databricks/api:DATABRICKS_ACCOUNT_ID",
  "databricks/api:DATABRICKS_HOST",
  "datadog/agent:DD_SITE",
  "decap/cms:DECAP_GITHUB_CLIENT_ID",
  "devcycle/flags:DEVCYCLE_CLIENT_SDK_KEY",
  "devcycle/flags:DEVCYCLE_MOBILE_SDK_KEY",
  "dgraph/cloud:DGRAPH_ENDPOINT",
  "directus/api:DIRECTUS_URL",
  "dokku/deploy:DOKKU_HOST",
  "doppler/cli:DOPPLER_CONFIG",
  "doppler/cli:DOPPLER_PROJECT",
  "drone/api:DRONE_SERVER",
  "dynatrace/api:DYNATRACE_ENV_URL",
  "ecwid/store:ECWID_PUBLIC_TOKEN",
  "eppo/flags:EPPO_CLIENT_TOKEN",
  "fathom/analytics:FATHOM_SITE_ID",
  "filestack/api:FILESTACK_API_KEY",
  "firebase/web:FIREBASE_API_KEY",
  "firebase/web:FIREBASE_APP_ID",
  "firebase/web:FIREBASE_AUTH_DOMAIN",
  "firebase/web:FIREBASE_MESSAGING_SENDER_ID",
  "firebase/web:FIREBASE_PROJECT_ID",
  "firebase/web:FIREBASE_STORAGE_BUCKET",
  "flagd/provider:FLAGD_HOST",
  "flagd/provider:FLAGD_PORT",
  "flagsmith/flags:FLAGSMITH_ENVIRONMENT_KEY",
  "forgejo/api:FORGEJO_URL",
  "fourthwall/api:FOURTHWALL_STOREFRONT_TOKEN",
  "freshpaint/analytics:FRESHPAINT_ENVIRONMENT_ID",
  "freshsales/api:FRESHSALES_DOMAIN",
  "frontegg/auth:FRONTEGG_BASE_URL",
  "frontegg/auth:FRONTEGG_CLIENT_ID",
  "fullstory/analytics:FULLSTORY_ORG_ID",
  "fusionauth/api:FUSIONAUTH_URL",
  "ga4/measurement:GA4_MEASUREMENT_ID",
  "getstream/chat:STREAM_API_KEY",
  "ghost/content:GHOST_API_URL",
  "ghost/content:GHOST_CONTENT_API_KEY",
  "gitea/api:GITEA_URL",
  "gorgias/api:GORGIAS_DOMAIN",
  "growthbook/flags:GROWTHBOOK_CLIENT_KEY",
  "growthbook/flags:GROWTHBOOK_DECRYPTION_KEY",
  "gtm/container:GTM_CONTAINER_ID",
  "gumlet/media:GUMLET_SOURCE_HOST",
  "hanko/auth:HANKO_API_URL",
  "harness/api:HARNESS_ACCOUNT_ID",
  "heap/analytics:HEAP_APP_ID",
  "highlight/session:HIGHLIGHT_PROJECT_ID",
  "honeycomb/otel:OTEL_EXPORTER_OTLP_ENDPOINT",
  "honeycomb/otel:OTEL_SERVICE_NAME",
  "hotjar/analytics:HOTJAR_SITE_ID",
  "hubspot/api:HUBSPOT_HUB_ID",
  "hygraph/api:HYGRAPH_ENDPOINT",
  "imagekit/media:IMAGEKIT_PUBLIC_KEY",
  "imagekit/media:IMAGEKIT_URL_ENDPOINT",
  "imgix/source:IMGIX_DOMAIN",
  "infisical/cli:INFISICAL_API_URL",
  "infisical/cli:INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
  "influxdb/v3:INFLUXDB3_DATABASE_NAME",
  "influxdb/v3:INFLUXDB3_HOST_URL",
  "infobip/api:INFOBIP_BASE_URL",
  "instana/agent:INSTANA_ENDPOINT_URL",
  "intercom/api:INTERCOM_APP_ID",
  "jaeger/tracing:JAEGER_ENDPOINT",
  "jenkins/api:JENKINS_URL",
  "jfrog/artifactory:JFROG_URL",
  "jira/api:JIRA_BASE_URL",
  "june/analytics:JUNE_WRITE_KEY",
  "kameleoon/flags:KAMELEOON_SITE_CODE",
  "kinde/auth:KINDE_ISSUER_URL",
  "kinde/auth:KINDE_POST_LOGIN_REDIRECT_URL",
  "kinde/auth:KINDE_POST_LOGOUT_REDIRECT_URL",
  "kinde/auth:KINDE_SITE_URL",
  "klaviyo/api:KLAVIYO_PUBLIC_API_KEY",
  "knock/notifications:KNOCK_PUBLIC_KEY",
  "kontent/delivery:KONTENT_ENVIRONMENT_ID",
  "lancedb/cloud:LANCEDB_URI",
  "langfuse/tracing:LANGFUSE_BASE_URL",
  "langfuse/tracing:LANGFUSE_PUBLIC_KEY",
  "last9/otel:LAST9_OTLP_ENDPOINT",
  "launchdarkly/flags:LAUNCHDARKLY_CLIENT_SIDE_ID",
  "launchdarkly/flags:LAUNCHDARKLY_MOBILE_KEY",
  "livechat/api:LIVECHAT_CLIENT_ID",
  "livechat/api:LIVECHAT_LICENSE_ID",
  "livekit/realtime:LIVEKIT_URL",
  "logrocket/session:LOGROCKET_APP_ID",
  "logto/auth:LOGTO_APP_ID",
  "logto/auth:LOGTO_ENDPOINT",
  "loki/logs:LOKI_URL",
  "magic/auth:MAGIC_PUBLISHABLE_KEY",
  "mailchimp/marketing:MAILCHIMP_SERVER_PREFIX",
  "mailgun/email:MAILGUN_DOMAIN",
  "mapbox/maps:MAPBOX_ACCESS_TOKEN",
  "marqo/cloud:MARQO_URL",
  "matomo/analytics:MATOMO_SITE_ID",
  "matomo/analytics:MATOMO_URL",
  "medusa/storefront:MEDUSA_BACKEND_URL",
  "medusa/storefront:MEDUSA_PUBLISHABLE_KEY",
  "meilisearch/server:MEILI_SEARCH_KEY",
  "memgraph/server:MEMGRAPH_URI",
  "midtrans/api:MIDTRANS_CLIENT_KEY",
  "milvus/server:MILVUS_URI",
  "minio/storage:MINIO_ENDPOINT",
  "mixpanel/analytics:MIXPANEL_TOKEN",
  "myscale/cloud:MYSCALE_HOST",
  "neo4j/aura:NEO4J_URI",
  "neptune/tracking:NEPTUNE_PROJECT",
  "okta/app:OKTA_CLIENT_ORGURL",
  "ollama/server:OLLAMA_HOST",
  "onepassword/connect:OP_CONNECT_HOST",
  "onesignal/push:ONESIGNAL_APP_ID",
  "openai/api:OPENAI_ORG_ID",
  "openobserve/logs:OPENOBSERVE_URL",
  "opensearch/cluster:OPENSEARCH_URL",
  "optimizely/flags:OPTIMIZELY_SDK_KEY",
  "oracle/cli:OCI_CLI_REGION",
  "orama/cloud:ORAMA_ENDPOINT",
  "orama/cloud:ORAMA_PUBLIC_API_KEY",
  "ory/network:ORY_SDK_URL",
  "otelcollector/exporter:OTEL_EXPORTER_OTLP_PROTOCOL",
  "ovh/api:OVH_ENDPOINT",
  "paddle/billing:PADDLE_CLIENT_TOKEN",
  "payload/cms:PAYLOAD_PUBLIC_SERVER_URL",
  "paypal/api:PAYPAL_CLIENT_ID",
  "plasmic/api:PLASMIC_PROJECT_API_TOKEN",
  "plasmic/api:PLASMIC_PROJECT_ID",
  "portone/payments:PORTONE_CHANNEL_KEY",
  "portone/payments:PORTONE_STORE_ID",
  "posthog/analytics:NEXT_PUBLIC_POSTHOG_HOST",
  "posthog/analytics:NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
  "prometheus/remotewrite:PROMETHEUS_REMOTE_WRITE_URL",
  "propelauth/api:PROPELAUTH_AUTH_URL",
  "pusher/channels:PUSHER_CLUSTER",
  "pusher/channels:PUSHER_KEY",
  "qase/api:QASE_TESTOPS_PROJECT",
  "qdrant/cloud:QDRANT_URL",
  "questdb/server:QUESTDB_HTTP_URL",
  "radar/location:RADAR_PUBLISHABLE_KEY",
  "raygun/errors:RAYGUN_API_KEY",
  "recurly/api:RECURLY_PUBLIC_KEY",
  "reportportal/api:REPORTPORTAL_ENDPOINT",
  "rocketchat/api:ROCKETCHAT_URL",
  "rollbar/errors:ROLLBAR_CLIENT_TOKEN",
  "rudderstack/analytics:RUDDERSTACK_DATA_PLANE_URL",
  "rudderstack/analytics:RUDDERSTACK_WRITE_KEY",
  "saleor/api:SALEOR_API_URL",
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
  "ses/email:AWS_SES_REGION",
  "shopify/app:SHOPIFY_STOREFRONT_ACCESS_TOKEN",
  "shopware/api:SHOPWARE_ACCESS_TOKEN",
  "signoz/otel:SIGNOZ_ENDPOINT",
  "sinch/api:SINCH_KEY_ID",
  "smartlook/analytics:SMARTLOOK_PROJECT_KEY",
  "snipcart/cart:SNIPCART_PUBLIC_API_KEY",
  "snowflake/cli:SNOWFLAKE_ACCOUNT",
  "snowplow/collector:SNOWPLOW_COLLECTOR_URL",
  "solr/server:SOLR_URL",
  "spacelift/api:SPACELIFT_API_KEY_ENDPOINT",
  "split/flags:SPLIT_CLIENT_SDK_API_KEY",
  "splunk/hec:SPLUNK_HEC_URL",
  "square/payments:SQ_APPLICATION_ID",
  "statsig/flags:STATSIG_CLIENT_API_KEY",
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
  "swell/store:SWELL_PUBLIC_KEY",
  "swell/store:SWELL_STORE_ID",
  "teamcity/api:TEAMCITY_URL",
  "telnyx/api:TELNYX_PUBLIC_KEY",
  "testrail/api:TESTRAIL_URL",
  "tidio/api:TIDIO_PUBLIC_KEY",
  "tina/cms:TINA_CLIENT_ID",
  "tosspayments/api:TOSS_CLIENT_KEY",
  "transloadit/api:TRANSLOADIT_AUTH_KEY",
  "turbopuffer/api:TURBOPUFFER_REGION",
  "turso/database:TURSO_ORG",
  "twicpics/media:TWICPICS_DOMAIN",
  "typesense/search:TYPESENSE_SEARCH_ONLY_API_KEY",
  "umami/analytics:UMAMI_WEBSITE_ID",
  "uniform/api:UNIFORM_PROJECT_ID",
  "unleash/flags:UNLEASH_FRONTEND_TOKEN",
  "unstructured/api:UNSTRUCTURED_API_URL",
  "uploadcare/api:UPLOADCARE_PUBLIC_KEY",
  "upstash/redis:UPSTASH_REDIS_REST_URL",
  "vault/server:VAULT_ADDR",
  "vault/server:VAULT_NAMESPACE",
  "vendure/storefront:VENDURE_CHANNEL_TOKEN",
  "vendure/storefront:VENDURE_SHOP_API_URL",
  "vercel/deploy:VERCEL_ORG_ID",
  "vercel/deploy:VERCEL_PROJECT_ID",
  "victoriametrics/cloud:VICTORIAMETRICS_URL",
  "vwo/flags:VWO_ACCOUNT_ID",
  "vwo/flags:VWO_SDK_KEY",
  "wandb/tracking:WANDB_ENTITY",
  "wasabi/storage:WASABI_REGION",
  "weaviate/cloud:WEAVIATE_URL",
  "webiny/api:WEBINY_API_URL",
  "woodpecker/api:WOODPECKER_SERVER",
  "woopra/analytics:WOOPRA_PROJECT",
  "youtrack/api:YOUTRACK_URL",
  "zilliz/cloud:ZILLIZ_URI",
  "zitadel/auth:ZITADEL_CLIENT_ID",
  "zitadel/auth:ZITADEL_ISSUER",
  "zoho/crm:ZOHO_API_DOMAIN",
  "zulip/bot:ZULIP_SITE",
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
 * Unleash: frontend tokens are not considered secret and are safe to expose
 * client-side, unlike the backend tokens that share their shape.
 * Eppo: the client token is the one Eppo says browsers and mobile apps use,
 * and configuration is always obfuscated when it is.
 * BigCommerce: storefront tokens are designed for use from a web browser.
 * Ecwid: the public token is safe to use on the storefront.
 * Shopware, Vendure, Fourthwall: no sentence, but each vendor own reference
 * storefront carries the value into the browser by design.
 * Contentstack: the delivery token is read-only over published content and is
 * the half Contentstack pairs with the stack key in its frontend SDK, the same
 * split Contentful draws between delivery and management.
 * Plasmic: the project API token is read-only and the browser loader fetches
 * with it, which is the direction that admits it.
 */
const ALLOWED_DESPITE_NAME: readonly string[] = [
  "bigcommerce/api:BIGCOMMERCE_STOREFRONT_API_TOKEN",
  "contentful/delivery:CONTENTFUL_DELIVERY_TOKEN",
  "contentstack/delivery:CONTENTSTACK_DELIVERY_TOKEN",
  "ecwid/store:ECWID_PUBLIC_TOKEN",
  "eppo/flags:EPPO_CLIENT_TOKEN",
  "fourthwall/api:FOURTHWALL_STOREFRONT_TOKEN",
  "mapbox/maps:MAPBOX_ACCESS_TOKEN",
  "mixpanel/analytics:MIXPANEL_TOKEN",
  "paddle/billing:PADDLE_CLIENT_TOKEN",
  "plasmic/api:PLASMIC_PROJECT_API_TOKEN",
  "posthog/analytics:NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN",
  "rollbar/errors:ROLLBAR_CLIENT_TOKEN",
  "shopify/app:SHOPIFY_STOREFRONT_ACCESS_TOKEN",
  "shopware/api:SHOPWARE_ACCESS_TOKEN",
  "storyblok/delivery:STORYBLOK_PUBLIC_TOKEN",
  "stytch/auth:STYTCH_PUBLIC_TOKEN",
  "unleash/flags:UNLEASH_FRONTEND_TOKEN",
  "vendure/storefront:VENDURE_CHANNEL_TOKEN",
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
