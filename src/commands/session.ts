import type { Command } from "../cli/command.js";
import {
  access,
  account,
  fetcher,
  setting,
  DEFAULT_CLIENT,
  DEFAULT_ISSUER,
  DEFAULT_RESOURCE,
  DEFAULT_SCOPE,
  RemoteError,
} from "../remote/client.js";
import {
  clearSession,
  discover,
  pollOnce,
  readSession,
  revoke,
  startDevice,
  writeSession,
} from "../remote/session.js";

/**
 * Signing in is optional. Everything else in this tool works without it, and
 * the only thing it unlocks is a remote the catalog can be pushed to.
 */

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
        writeSession(outcome.session, env["HOME"]);
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
    const session = readSession(env["HOME"]);
    if (!session) {
      ui.info("not signed in", "nothing to forget");
      return 0;
    }
    const clientId =
      session.clientId ?? setting(env, "ENVS_OAUTH_CLIENT_ID", DEFAULT_CLIENT);
    // The local copy goes first. If revocation fails the token is still gone
    // from this machine, which is what the person asked for.
    clearSession(env["HOME"]);
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

/** The account behind the sign-in, or nothing when the hub cannot be reached.
 * Never the token: knowing it is present is the answer. */
async function describeAccount(
  env: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, unknown> | null> {
  try {
    const who = await account(await access(env));
    return {
      account: who.userId,
      subscription: who.subscription,
      snapshots: who.catalogs.filter((c) => c.id.endsWith(".envsnap")).length,
      teams: who.teams,
      members: who.members,
    };
  } catch {
    return null;
  }
}

export const whoamiCommand: Command = {
  name: "whoami",
  describe: "whether this machine is signed in, and to what",
  usage: "envs whoami [--json]",
  options: [
    { name: "json", boolean: true, describe: "answer as one JSON object" },
  ],

  async run({ ui, args, env }) {
    // This command exists to answer a question, so the answer is data and
    // goes to stdout. Everything a person reads around it stays on stderr.
    const asJson = args.flags.has("json");
    const answer = (value: Record<string, unknown>): void => {
      ui.data(`${JSON.stringify(value)}\n`);
    };

    const session = readSession(env["HOME"]);
    if (!session) {
      if (asJson) answer({ signedIn: false });
      else ui.data("not signed in\n");
      ui.info("not signed in", "run envs login");
      return 1;
    }
    if (asJson) {
      const account = await describeAccount(env);
      answer({
        signedIn: true,
        issuer: session.issuer,
        ...(session.scope ? { scope: session.scope } : {}),
        ...(account ?? {}),
      });
      return 0;
    }
    ui.data(`signed in to ${session.issuer}\n`);
    ui.info("issuer", session.issuer);
    if (session.scope) ui.info("scope", session.scope);
    if (session.expiresAt !== undefined) {
      const left = session.expiresAt - Date.now();
      ui.info(
        "token",
        left > 0
          ? `valid for ${String(Math.floor(left / 60000))} min`
          : "expired, will renew on next use",
      );
    }

    // What the sign-in is actually for. A token that parses but buys nothing
    // is the state this command exists to make visible.
    try {
      const who = await account(await access(env));
      ui.info("account", who.userId);
      ui.info(
        "subscription",
        who.subscription === "active"
          ? "active"
          : who.subscription === "inactive"
            ? "none; envs:// destinations will be refused"
            : "could not be read; try again shortly",
      );
      const snapshots = who.catalogs.filter((entry) =>
        entry.id.endsWith(".envsnap"),
      );
      ui.info("snapshots", String(snapshots.length));
      if (who.teams.length > 0) ui.info("member of", who.teams.join(" "));
      if (who.members.length > 0)
        ui.info("shared with", who.members.join(" "));
    } catch (error) {
      ui.info(
        "account",
        error instanceof RemoteError
          ? `${error.message}${error.detail ? ` — ${error.detail}` : ""}`
          : "could not be reached",
      );
    }
    // The token itself is never printed. Knowing it is present is the answer.
    return 0;
  },
};
