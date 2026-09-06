/**
 * Resolving a template name to its bytes. The registry is static files, so
 * this is one GET of a fixed shape: no server, no query, no redirect.
 */

import { TemplateError } from "./schema.js";

export const DEFAULT_REGISTRY = "https://envs.build/v1/templates";

/** The same shape the schema admits, restated so a name cannot walk the path. */
const NAME = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]\/[a-z0-9][a-z0-9-]{0,38}$/;

/** A template is a few KB. Anything larger is not one. */
const MAX_BYTES = 64 * 1024;

export const looksLikeName = (value: string): boolean => NAME.test(value);

export function templateUrl(name: string, registry: string): string {
  if (!NAME.test(name)) {
    throw new TemplateError(
      `"${name}" is not a template name; use publisher/template`,
    );
  }
  const base = new URL(`${registry.replace(/\/+$/, "")}/`);
  if (base.protocol !== "https:" && base.hostname !== "localhost") {
    throw new TemplateError("the registry must be served over https");
  }
  // Built from a validated name onto a fixed base, so no input reaches the
  // path as anything but two known-safe segments.
  return new URL(`${name}.json`, base).toString();
}

export async function fetchTemplate(
  name: string,
  registry: string = DEFAULT_REGISTRY,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const url = templateUrl(name, registry);
  let response: Response;
  try {
    response = await fetcher(url, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new TemplateError(
      `could not reach the registry: ${error instanceof Error ? error.message : "failed"}`,
    );
  }
  if (response.status === 404) {
    throw new TemplateError(`no template named "${name}" in the registry`);
  }
  if (!response.ok) {
    throw new TemplateError(
      `the registry refused: ${String(response.status)}`,
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) {
    throw new TemplateError("that template is larger than a template can be");
  }
  const text = await response.text();
  if (text.length > MAX_BYTES) {
    throw new TemplateError("that template is larger than a template can be");
  }
  return text;
}
