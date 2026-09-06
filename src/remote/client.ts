/**
 * The hosted side of the tool. Everything here is optional: the catalog, the
 * commands and config() all work with no account, and this is only reached
 * once someone has signed in.
 */

import {
  discover,
  readSession,
  refresh,
  writeSession,
  type Fetcher,
  type StoredSession,
} from "./session.js";

export const DEFAULT_ISSUER = "https://auth.envs.build";
export const DEFAULT_CLIENT = "https://auth.envs.build/oauth-client.json";
export const DEFAULT_RESOURCE = "https://api.envs.build";
export const DEFAULT_SCOPE =
  "envs:catalog:read envs:catalog:write envs:team:manage";

export type Env = Readonly<Record<string, string | undefined>>;

export const setting = (env: Env, name: string, fallback: string): string =>
  env[name] ?? fallback;

export const fetcher: Fetcher = (url, init) =>
  fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  }) as unknown as ReturnType<Fetcher>;

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    /** Present when the remote answered. Callers branch on this, never on the
     * message, which is written for a person. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

/** Renewed this far ahead of expiry, so a long upload does not start on a
 * token that dies mid-request. */
const RENEW_BEFORE_MS = 60_000;

export interface Access {
  readonly token: string;
  readonly resource: string;
}

export function storedSession(env: Env): StoredSession | null {
  return readSession(env["HOME"]);
}

/**
 * A usable token, renewed if it is about to expire. A refresh that fails is
 * not fatal here: the token may still be good, and the request that follows
 * is the honest test of that.
 */
export async function access(env: Env): Promise<Access> {
  const session = storedSession(env);
  if (!session) {
    throw new RemoteError("not signed in", "run envs login");
  }
  const resource = setting(env, "ENVS_RESOURCE", DEFAULT_RESOURCE).replace(
    /\/+$/,
    "",
  );
  const stale =
    session.expiresAt !== undefined &&
    session.expiresAt - Date.now() < RENEW_BEFORE_MS;
  if (!stale) return { token: session.accessToken, resource };

  const clientId =
    session.clientId ?? setting(env, "ENVS_OAUTH_CLIENT_ID", DEFAULT_CLIENT);
  try {
    const metadata = await discover(session.issuer, fetcher);
    const renewed = await refresh(metadata, session, clientId, fetcher);
    if (renewed) {
      writeSession(renewed, env["HOME"]);
      return { token: renewed.accessToken, resource };
    }
  } catch {
    // Fall through: report the request's own failure, not the renewal's.
  }
  return { token: session.accessToken, resource };
}

export interface HubRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
  readonly accept?: string;
}

/** What each status means to someone at a terminal, rather than a number. */
function explain(status: number, path: string, body: string): RemoteError {
  const detail = body.slice(0, 200);
  const said = (message: string, why?: string): RemoteError =>
    new RemoteError(message, why, status);
  switch (status) {
    case 401:
      return said("sign-in expired", "run envs login again");
    case 402:
      return said(
        "this destination needs a subscription",
        "your catalog is untouched and stays readable; see envs.build",
      );
    case 403:
      return said("this sign-in may not do that", detail);
    case 404:
      return said("not found on the remote", path);
    case 409:
      return said("the remote read different bytes", detail);
    case 412:
      return said(
        "the remote moved since you last read it",
        "someone else wrote it; read it again before writing",
      );
    case 413:
      return said("snapshot is too large for the remote", detail);
    case 428:
      return said("refusing to overwrite blindly", detail);
    default:
      return said(`remote refused: ${String(status)}`, detail);
  }
}

export async function hub(
  grant: Access,
  request: HubRequest,
): Promise<Response> {
  const url = `${grant.resource}${request.path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${grant.token}`,
        accept: request.accept ?? "application/json",
        ...(request.headers ?? {}),
      },
      ...(request.body
        ? {
            body: request.body.slice().buffer as ArrayBuffer,
            duplex: "half",
          }
        : {}),
    } as RequestInit);
  } catch (error) {
    throw new RemoteError(
      "could not reach the remote",
      error instanceof Error ? error.message : undefined,
    );
  }
  if (!response.ok) {
    throw explain(response.status, request.path, await response.text());
  }
  return response;
}

export interface RemoteCatalog {
  readonly id: string;
  readonly version: string;
  readonly bytes: number;
  readonly updatedAt: string;
}

export interface Account {
  readonly userId: string;
  readonly subscription: "active" | "inactive" | "unavailable";
  readonly catalogs: readonly RemoteCatalog[];
  readonly members: readonly string[];
  readonly teams: readonly string[];
  readonly teamManagement: boolean;
}

export async function account(grant: Access): Promise<Account> {
  const body = (await (
    await hub(grant, { method: "GET", path: "/v1/me" })
  ).json()) as Record<string, unknown>;
  const subscription = body["subscription"];
  return {
    userId: String(body["userId"] ?? ""),
    subscription:
      subscription === "active" || subscription === "inactive"
        ? subscription
        : "unavailable",
    catalogs: Array.isArray(body["catalogs"])
      ? (body["catalogs"] as RemoteCatalog[])
      : [],
    members: Array.isArray(body["members"])
      ? (body["members"] as string[])
      : [],
    teams: Array.isArray(body["teams"]) ? (body["teams"] as string[]) : [],
    teamManagement:
      (body["capabilities"] as { teamManagement?: unknown } | undefined)
        ?.teamManagement === true,
  };
}
