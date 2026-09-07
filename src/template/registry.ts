/**
 * Who may publish under a name, and where a template may send someone to get
 * a key. Both live here because the lint and the publish gate must ask the
 * same question; a check in one place only is a check with a way around it.
 */

import { TemplateError } from "./schema.js";

/**
 * The map below is a fallback, not the authority. A provider arriving must not
 * need a new CLI: the registry publishes the same data at /v1/namespaces.json,
 * and an installed copy that never updates would otherwise refuse every
 * template published after it. What ships here is what a first run can check
 * before it has reached the network.
 */
export interface NamespaceMap {
  readonly [namespace: string]: readonly string[];
}

let learned: NamespaceMap = {};

/**
 * Reservations read from the same document. Deliberately consulted only by the
 * publish gate, which reads the repository's own copy: a consumer never needs
 * this list, so a registry cannot un-reserve a name for anybody.
 */
let learnedReserved: readonly string[] | null = null;

export function learnReserved(names: readonly string[]): void {
  learnedReserved = names;
}

/** One source for both the warning and the refusal, which must not disagree. */
export function reservedNamespaces(): readonly string[] {
  return learnedReserved ?? RESERVED_NAMESPACES;
}

export function parseReserved(payload: string): readonly string[] {
  const body = JSON.parse(payload) as { reserved?: unknown };
  if (body.reserved === undefined) return [];
  if (!Array.isArray(body.reserved)) {
    throw new TemplateError("reserved must be a list of namespace names");
  }
  for (const name of body.reserved) {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(name)) {
      throw new TemplateError(`"${String(name)}" is not a namespace name`);
    }
  }
  return body.reserved as string[];
}

/** Adopted from the registry that served the template, alongside the template. */
export function learnNamespaces(map: NamespaceMap): void {
  learned = map;
}

export function knownDomains(namespace: string): readonly string[] | undefined {
  return learned[namespace] ?? OBTAIN_DOMAINS[namespace];
}

export function parseNamespaceMap(payload: string): NamespaceMap {
  const body = JSON.parse(payload) as { namespaces?: unknown };
  const namespaces = body.namespaces;
  if (typeof namespaces !== "object" || namespaces === null) {
    throw new TemplateError("namespaces document has no namespaces object");
  }
  const map: Record<string, string[]> = {};
  for (const [name, hosts] of Object.entries(namespaces)) {
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(name)) {
      throw new TemplateError(`"${name}" is not a namespace name`);
    }
    if (!Array.isArray(hosts) || hosts.length === 0) {
      throw new TemplateError(`"${name}" lists no hosts`);
    }
    for (const host of hosts) {
      // A host, never a URL: a path or a scheme here would let one entry widen
      // into another provider's origin.
      if (typeof host !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
        throw new TemplateError(
          `"${name}" lists "${String(host)}", not a host`,
        );
      }
    }
    map[name] = hosts as string[];
  }
  return map;
}

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
  const allowed = knownDomains(namespaceOf(name));
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
  if (!reservedNamespaces().includes(namespace)) return;
  if (publisher !== "modootoday") {
    throw new TemplateError(
      `"${namespace}" is a reserved namespace`,
      "template",
    );
  }
}
