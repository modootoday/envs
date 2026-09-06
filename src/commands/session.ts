import type { Command } from "../cli/command.js";
import {
  clearSession,
  discover,
  pollOnce,
  readSession,
  revoke,
  startDevice,
  writeSession,
  type Fetcher,
} from "../remote/session.js";

/**
 * Signing in is optional. Everything else in this tool works without it, and
 * the only thing it unlocks is a remote the catalog can be pushed to.
 */
const DEFAULT_ISSUER = "https://auth.envs.build";
const DEFAULT_CLIENT = "https://auth.envs.build/oauth-client.json";
const DEFAULT_RESOURCE = "https://api.envs.build";
const DEFAULT_SCOPE = "envs:catalog:read envs:catalog:write envs:team:manage";

const fetcher: Fetcher = (url, init) =>
  fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  }) as unknown as ReturnType<Fetcher>;

const setting = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
): string => env[name] ?? fallback;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const loginCommand: Command = {
  name: "login",
  describe: "sign in on this machine, for a remote catalog",
  usage: "envs login [--issuer <url>]",
  options: [
    {
      name: "issuer",
      describe: "override the auth issuer",
      placeholder: "<url>",
    },
  ],

  async run({ ui, args, env }) {
    const issuer =
      args.options.get("issuer")?.[0] ??
      setting(env, "ENVS_AUTH_ISSUER", DEFAULT_ISSUER);
    const clientId = setting(env, "ENVS_OAUTH_CLIENT_ID", DEFAULT_CLIENT);
    const resource = setting(env, "ENVS_OAUTH_RESOURCE", DEFAULT_RESOURCE);
    const scope = setting(env, "ENVS_OAUTH_SCOPE", DEFAULT_SCOPE);

    let metadata;
    try {
      metadata = await discover(issuer, fetcher);
    } catch (error) {
      ui.error("cannot sign in", (error as Error).message);
      return 1;
    }

    let start;
    try {
      start = await startDevice(
        metadata,
        { clientId, resource, scope },
        fetcher,
      );
    } catch (error) {
      ui.error("cannot start sign-in", (error as Error).message);
      return 1;
    }

    // No browser is opened. This terminal may be on a machine nobody is
    // looking at, and the code is short enough to carry to one that is.
    ui.info("open", start.verificationUriComplete ?? start.verificationUri);
    ui.info("code", start.userCode);
    ui.line();
    ui.info("waiting", "approve it and this finishes on its own");

    let interval = start.intervalMs;
    for (;;) {
      if (Date.now() >= start.expiresAt) {
        ui.error("expired", "the code timed out; run envs login again");
        return 1;
      }
      await wait(interval);
      const outcome = await pollOnce(
        metadata,
        { clientId, deviceCode: start.deviceCode, issuer },
        fetcher,
      );
      if (outcome.kind === "granted" && outcome.session) {
        writeSession(outcome.session);
        ui.success("signed in", issuer);
        return 0;
      }
      // The server asks for a slower cadence by name, and ignoring it is how a
      // client gets rate limited into failing.
      if (outcome.kind === "slow_down") interval += 5000;
      if (outcome.kind === "denied") {
        ui.error("declined", "the request was not approved");
        return 1;
      }
      if (outcome.kind === "expired") {
        ui.error("expired", "the code timed out; run envs login again");
        return 1;
      }
    }
  },
};

export const logoutCommand: Command = {
  name: "logout",
  describe: "forget the sign-in on this machine",
  usage: "envs logout",

  async run({ ui, env }) {
    const session = readSession();
    if (!session) {
      ui.info("not signed in", "nothing to forget");
      return 0;
    }
    const clientId =
      session.clientId ?? setting(env, "ENVS_OAUTH_CLIENT_ID", DEFAULT_CLIENT);
    // The local copy goes first. If revocation fails the token is still gone
    // from this machine, which is what the person asked for.
    clearSession();
    try {
      const metadata = await discover(session.issuer, fetcher);
      const revoked = await revoke(metadata, session, clientId, fetcher);
      ui.success(
        "signed out",
        revoked
          ? "access and refresh credentials revoked"
          : "local copy removed; remote revocation was not confirmed",
      );
    } catch {
      ui.success(
        "signed out",
        "local copy removed; remote revocation was not confirmed",
      );
    }
    return 0;
  },
};

export const whoamiCommand: Command = {
  name: "whoami",
  describe: "whether this machine is signed in, and to what",
  usage: "envs whoami",

  run({ ui }) {
    const session = readSession();
    if (!session) {
      ui.info("not signed in", "run envs login");
      return 1;
    }
    ui.info("issuer", session.issuer);
    if (session.scope) ui.info("scope", session.scope);
    if (session.expiresAt !== undefined) {
      const left = session.expiresAt - Date.now();
      ui.info(
        "token",
        left > 0
          ? `valid for ${String(Math.floor(left / 60000))} min`
          : "expired, run envs login",
      );
    }
    // The token itself is never printed. Knowing it is present is the answer.
    return 0;
  },
};
