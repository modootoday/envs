import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { globalDir } from "../loader/locate.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface IssuerMetadata {
  readonly issuer?: string;
  readonly token_endpoint: string;
  readonly device_authorization_endpoint: string;
  readonly revocation_endpoint?: string;
  readonly grant_types_supported?: readonly string[];
  readonly scopes_supported?: readonly string[];
}

export interface DeviceStart {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly deviceCode: string;
  readonly intervalMs: number;
  readonly expiresAt: number;
}

export interface StoredSession {
  readonly issuer: string;
  readonly clientId?: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly scope?: string;
}

export type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const form = (fields: Record<string, string>): string =>
  new URLSearchParams(fields).toString();

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

function validateIssuerUrl(value: string, issuer: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== new URL(issuer).origin ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("OAuth endpoint must stay on the issuer origin");
}

export async function discover(
  issuer: string,
  fetcher: Fetcher,
): Promise<IssuerMetadata> {
  const base = issuer.replace(/\/+$/, "");
  const source = new URL(base);
  if (
    source.protocol !== "https:" ||
    source.username ||
    source.password ||
    source.search ||
    source.hash ||
    source.pathname !== "/"
  )
    throw new Error("issuer must be an HTTPS origin");
  const res = await fetcher(`${base}/.well-known/oauth-authorization-server`);
  if (!res.ok)
    throw new Error(`issuer did not answer discovery (${res.status})`);
  const body = (await res.json()) as IssuerMetadata;
  if (!body.token_endpoint || !body.device_authorization_endpoint) {
    throw new Error("issuer advertises no device grant");
  }
  if (!body.issuer || new URL(body.issuer).toString() !== source.toString()) {
    throw new Error("discovery issuer mismatch");
  }
  for (const endpoint of [
    body.token_endpoint,
    body.device_authorization_endpoint,
    body.revocation_endpoint,
  ]) {
    if (endpoint !== undefined) validateIssuerUrl(endpoint, base);
  }
  const grants = body.grant_types_supported ?? [];
  if (grants.length > 0 && !grants.includes(DEVICE_GRANT)) {
    throw new Error("issuer does not support the device grant");
  }
  return body;
}

export async function startDevice(
  metadata: IssuerMetadata,
  request: { clientId: string; resource: string; scope: string },
  fetcher: Fetcher,
  now: () => number = Date.now,
): Promise<DeviceStart> {
  const res = await fetcher(metadata.device_authorization_endpoint, {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      client_id: request.clientId,
      resource: request.resource,
      scope: request.scope,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      String(body["error"] ?? `device request failed (${res.status})`),
    );
  }
  const deviceCode = body["device_code"];
  const userCode = body["user_code"];
  const verificationUri = body["verification_uri"];
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string"
  ) {
    throw new Error("device response is missing a field");
  }
  const interval = Number(body["interval"] ?? 5);
  const expires = Number(body["expires_in"] ?? 600);
  const complete = body["verification_uri_complete"];
  validateIssuerUrl(verificationUri, metadata.device_authorization_endpoint);
  if (typeof complete === "string")
    validateIssuerUrl(complete, metadata.device_authorization_endpoint);
  if (
    !Number.isFinite(interval) ||
    interval < 1 ||
    interval > 300 ||
    !Number.isFinite(expires) ||
    expires < 1 ||
    expires > 3600
  )
    throw new Error("invalid device timing");
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof complete === "string"
      ? { verificationUriComplete: complete }
      : {}),
    intervalMs: (Number.isFinite(interval) ? interval : 5) * 1000,
    expiresAt: now() + (Number.isFinite(expires) ? expires : 600) * 1000,
  };
}

export interface PollOutcome {
  readonly kind: "granted" | "pending" | "slow_down" | "denied" | "expired";
  readonly session?: StoredSession;
}

export async function pollOnce(
  metadata: IssuerMetadata,
  request: { clientId: string; deviceCode: string; issuer: string },
  fetcher: Fetcher,
  now: () => number = Date.now,
): Promise<PollOutcome> {
  const res = await fetcher(metadata.token_endpoint, {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({
      grant_type: DEVICE_GRANT,
      device_code: request.deviceCode,
      client_id: request.clientId,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.ok) {
    const token = body["access_token"];
    if (typeof token !== "string")
      throw new Error("token response has no token");
    const expiresIn = Number(body["expires_in"]);
    const refresh = body["refresh_token"];
    const scope = body["scope"];
    return {
      kind: "granted",
      session: {
        issuer: request.issuer,
        clientId: request.clientId,
        accessToken: token,
        ...(typeof refresh === "string" ? { refreshToken: refresh } : {}),
        ...(Number.isFinite(expiresIn)
          ? { expiresAt: now() + expiresIn * 1000 }
          : {}),
        ...(typeof scope === "string" ? { scope } : {}),
      },
    };
  }
  switch (body["error"]) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "expired_token":
      return { kind: "expired" };
    default:
      return { kind: "denied" };
  }
}

const sessionPath = (home?: string): string =>
  join(globalDir(home), "session.json");

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function secureDirectory(home?: string, create = false): void {
  const dir = resolve(globalDir(home));
  for (let path = dirname(dir); ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    )
      throw new Error("unsafe session parent directory");
    if (path === dirname(path)) break;
  }
  if (create) mkdirSync(dir, { mode: 0o700 });
  const stat = lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error("unsafe session directory");
}

function parseSession(value: unknown): StoredSession {
  const session = value as StoredSession | null;
  if (
    !session ||
    typeof session.issuer !== "string" ||
    typeof session.accessToken !== "string" ||
    !session.accessToken ||
    (session.refreshToken !== undefined &&
      typeof session.refreshToken !== "string") ||
    (session.expiresAt !== undefined && !Number.isFinite(session.expiresAt))
  )
    throw new Error("invalid stored session");
  const issuer = new URL(session.issuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname !== "/"
  )
    throw new Error("invalid stored issuer");
  return session;
}

export function readSession(home?: string): StoredSession | null {
  let fd: number | undefined;
  try {
    secureDirectory(home);
    fd = openSync(sessionPath(home), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 65536
    )
      throw new Error("unsafe session file");
    return parseSession(JSON.parse(readFileSync(fd, "utf8")));
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeSession(session: StoredSession, home?: string): void {
  parseSession(session);
  try {
    secureDirectory(home);
  } catch (error) {
    if (!absent(error)) throw error;
    secureDirectory(home, true);
  }
  const path = sessionPath(home);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("unsafe session destination");
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const temporary = join(globalDir(home), `.session-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(session)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
}

export function clearSession(home?: string): void {
  try {
    secureDirectory(home);
    unlinkSync(sessionPath(home));
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

export async function revoke(
  metadata: IssuerMetadata,
  session: StoredSession,
  clientId: string,
  fetcher: Fetcher,
): Promise<boolean> {
  if (!metadata.revocation_endpoint) return false;
  validateIssuerUrl(metadata.revocation_endpoint, session.issuer);
  let ok = true;
  const tokens = [session.refreshToken, session.accessToken].filter(
    (token): token is string => typeof token === "string",
  );
  for (const token of tokens) {
    try {
      const res = await fetcher(metadata.revocation_endpoint, {
        method: "POST",
        headers: FORM_HEADERS,
        body: form({ token, client_id: clientId }),
      });
      if (!res.ok) ok = false;
    } catch {
      ok = false;
    }
  }
  return ok;
}
