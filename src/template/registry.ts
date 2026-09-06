/**
 * Who may publish under a name, and where a template may send someone to get
 * a key. Both live here because the lint and the publish gate must ask the
 * same question; a check in one place only is a check with a way around it.
 */

import { TemplateError } from "./schema.js";

/**
 * Provider namespaces we hold. Unreserved, a third party publishes
 * "stripe/backend" whose obtain link points at their own page, and the
 * distribution channel for that phishing page is our domain.
 */
export const RESERVED_NAMESPACES: readonly string[] = [
  "anthropic",
  "aws",
  "azure",
  "cloudflare",
  "datadog",
  "discord",
  "envs",
  "gcp",
  "github",
  "gitlab",
  "google",
  "openai",
  "postgres",
  "redis",
  "sentry",
  "slack",
  "stripe",
  "supabase",
  "twilio",
  "vercel",
];

/**
 * Where each namespace's keys legitimately come from. A template may only
 * point at its own provider, so a reserved name cannot link somewhere else.
 */
export const OBTAIN_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["console.anthropic.com"],
  aws: ["console.aws.amazon.com", "docs.aws.amazon.com"],
  azure: ["portal.azure.com", "learn.microsoft.com"],
  cloudflare: ["dash.cloudflare.com", "developers.cloudflare.com"],
  datadog: ["app.datadoghq.com", "docs.datadoghq.com"],
  discord: ["discord.com"],
  envs: ["envs.build"],
  gcp: ["console.cloud.google.com"],
  github: ["github.com", "docs.github.com"],
  gitlab: ["gitlab.com", "docs.gitlab.com"],
  google: ["console.cloud.google.com", "developers.google.com"],
  openai: ["platform.openai.com"],
  postgres: ["www.postgresql.org"],
  redis: ["redis.io"],
  sentry: ["sentry.io", "docs.sentry.io"],
  slack: ["api.slack.com"],
  stripe: ["dashboard.stripe.com", "docs.stripe.com"],
  supabase: ["supabase.com"],
  twilio: ["console.twilio.com"],
  vercel: ["vercel.com"],
};

export const namespaceOf = (name: string): string =>
  name.slice(0, name.indexOf("/"));

/**
 * An obtain URL must be https and must belong to the namespace it appears
 * under. An unreserved namespace has no allowlist, so it may not link out at
 * all: a link is exactly the thing worth impersonating.
 */
export function checkObtain(name: string, url: string, at: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TemplateError("obtain must be an absolute URL", at);
  }
  if (parsed.protocol !== "https:") {
    throw new TemplateError("obtain must be https", at);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TemplateError("obtain must not carry credentials", at);
  }
  const allowed = OBTAIN_DOMAINS[namespaceOf(name)];
  if (allowed === undefined) {
    throw new TemplateError(
      `namespace "${namespaceOf(name)}" has no obtain allowlist; templates under it may not link out`,
      at,
    );
  }
  if (!allowed.includes(parsed.hostname)) {
    throw new TemplateError(
      `obtain host "${parsed.hostname}" is not one of ${allowed.join(", ")}`,
      at,
    );
  }
}

/** Publishing under a held namespace is ours to do, not a stranger's. */
export function checkNamespace(name: string, publisher?: string): void {
  const namespace = namespaceOf(name);
  if (!RESERVED_NAMESPACES.includes(namespace)) return;
  if (publisher !== "modootoday") {
    throw new TemplateError(
      `"${namespace}" is a reserved namespace`,
      "template",
    );
  }
}
