/**
 * The hosted destination, as a third provider rather than a second mechanism.
 * It carries the same sealed snapshot the other two do, so the remote holds
 * bytes it cannot open: the key never leaves this machine.
 */

import {
  access,
  account,
  hub,
  storedSession,
  RemoteError,
  type Access,
  type Env,
} from "../remote/client.js";
import {
  BackupError,
  register,
  type BackupProvider,
  type StoredSnapshot,
} from "./provider.js";

/** The remote names blobs in a narrower charset than a snapshot name uses. */
const REMOTE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const scopeOf = (env: Env): string => {
  const raw = env["ENVS_REMOTE_SCOPE"] ?? "";
  return raw === "" ? "" : `${raw.replace(/[^A-Za-z0-9._-]/g, "-")}-`;
};

/**
 * A snapshot name carries the T and Z of an ISO stamp, which the remote's id
 * charset does not admit. Lowercasing is total over the generated alphabet
 * (hex, digits, dot, dash), so the mapping round-trips through a listing.
 */
export function remoteId(env: Env, name: string): string {
  const id = `${scopeOf(env)}${name}`.toLowerCase();
  if (!REMOTE_ID.test(id)) {
    throw new BackupError(
      `"${name}" cannot be named on the remote; it must be letters, digits, dot, dash or underscore`,
    );
  }
  return id;
}

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

async function currentVersion(
  grant: Access,
  owner: string,
  id: string,
): Promise<string | null> {
  try {
    const response = await hub(grant, {
      method: "GET",
      path: `/v1/catalogs/${owner}/${id}/head`,
    });
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch (error) {
    // Absent is not a failure: it is the difference between create and replace.
    if (error instanceof RemoteError && error.status === 404) return null;
    throw error;
  }
}

/** The signed-in account, resolved once per call rather than stored. */
async function grantFor(
  env: Env,
): Promise<{ grant: Access; who: Awaited<ReturnType<typeof account>> }> {
  const grant = await access(env);
  const who = await account(grant);
  if (who.userId === "") {
    throw new BackupError("the remote did not say who this sign-in belongs to");
  }
  return { grant, who };
}

export const remoteProvider: BackupProvider = {
  name: "envs",

  describe: (env) =>
    storedSession(env)
      ? `writes to ${env["ENVS_RESOURCE"] ?? "the hosted catalog"}`
      : "needs envs login",

  // Declared, not discovered by failing: without a sign-in there is nothing to
  // try, and the file provider stays the default.
  eligible: (env) => storedSession(env) !== null,

  async put(env, name, bytes) {
    const { grant, who } = await grantFor(env);
    const id = remoteId(env, name);
    const version = await currentVersion(grant, who.userId, id);
    await hub(grant, {
      method: "PUT",
      path: `/v1/catalogs/${who.userId}/${id}`,
      body: bytes,
      headers: {
        "content-type": "application/octet-stream",
        "x-envs-digest": await digestOf(bytes),
        // Says which of the two writes this is, so a concurrent write is
        // refused rather than silently overwriting someone else's snapshot.
        ...(version === null
          ? { "if-none-match": "*" }
          : { "if-match": `"${version}"` }),
      },
    });
  },

  async get(env, name) {
    const { grant, who } = await grantFor(env);
    const response = await hub(grant, {
      method: "GET",
      path: `/v1/catalogs/${who.userId}/${remoteId(env, name)}`,
      accept: "application/octet-stream",
    });
    return new Uint8Array(await response.arrayBuffer());
  },

  async list(env) {
    const { who } = await grantFor(env);
    const prefix = scopeOf(env);
    return who.catalogs
      .filter(
        (entry) =>
          entry.id.startsWith(prefix) && entry.id.endsWith(".envsnap"),
      )
      .map(
        (entry) =>
          ({
            name: entry.id,
            size: entry.bytes,
            ...(entry.updatedAt ? { modifiedAt: entry.updatedAt } : {}),
          }) satisfies StoredSnapshot,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  },
};

register(remoteProvider);
