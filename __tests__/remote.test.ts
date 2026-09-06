import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { destinationEnv } from "../src/commands/backup.js";
import { remoteId, remoteProvider } from "../src/backup/remote.js";
import { refresh, type IssuerMetadata } from "../src/remote/session.js";

const ISSUER = "https://auth.example.test";

const metadata: IssuerMetadata = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/token`,
  device_authorization_endpoint: `${ISSUER}/device`,
  revocation_endpoint: `${ISSUER}/revoke`,
};

/** A home with a signed-in session, written by hand so the test does not
 * depend on the writer it is meant to exercise separately. */
function signedInHome(): string {
  const home = mkdtempSync(join(tmpdir(), "envs-remote-"));
  mkdirSync(join(home, ".envs"), { mode: 0o700 });
  writeFileSync(
    join(home, ".envs", "session.json"),
    JSON.stringify({
      issuer: ISSUER,
      clientId: "https://auth.example.test/oauth-client.json",
      accessToken: "envs_access_test",
      refreshToken: "envs_refresh_test",
      expiresAt: Date.now() + 3_600_000,
      scope: "envs:catalog:read envs:catalog:write",
    }),
    { mode: 0o600 },
  );
  return home;
}

const reply = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(
    typeof body === "string" || body instanceof Uint8Array
      ? (body as BodyInit)
      : JSON.stringify(body),
    { status, headers },
  );

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers the hub calls the provider makes, and records them. */
function stubHub(routes: (url: string, method: string) => Response): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[name.toLowerCase()] = value;
    }
    sent.push({ url, method, headers });
    return routes(url, method);
  }) as typeof fetch;
  return sent;
}

describe("a destination names its provider by scheme", () => {
  it("routes envs:// to the hosted provider", () => {
    const chosen = destinationEnv({}, "envs://team");
    expect(chosen["ENVS_BACKUP_PROVIDER"]).toBe("envs");
    expect(chosen["ENVS_REMOTE_SCOPE"]).toBe("team");
  });

  it("takes envs:// with no scope", () => {
    const chosen = destinationEnv({}, "envs://");
    expect(chosen["ENVS_BACKUP_PROVIDER"]).toBe("envs");
    expect(chosen["ENVS_REMOTE_SCOPE"]).toBeUndefined();
  });

  it("splits s3://bucket/prefix rather than reading it as a directory", () => {
    // Measured: this used to become ENVS_BACKUP_DIR, so the tool wrote a
    // local folder literally named s3: and reported success.
    const chosen = destinationEnv({}, "s3://my-bucket/team/snapshots");
    expect(chosen["ENVS_BACKUP_PROVIDER"]).toBe("s3");
    expect(chosen["ENVS_BACKUP_BUCKET"]).toBe("my-bucket");
    expect(chosen["ENVS_BACKUP_PREFIX"]).toBe("team/snapshots");
  });

  it("still treats a plain path as a directory", () => {
    const chosen = destinationEnv({}, "./vault");
    expect(chosen["ENVS_BACKUP_PROVIDER"]).toBe("file");
    expect(chosen["ENVS_BACKUP_DIR"]).toBe("./vault");
  });
});

describe("a snapshot name maps onto the remote's id charset", () => {
  it("lowercases the stamp the remote would reject", () => {
    // The remote admits [a-z0-9][a-z0-9._-]{0,63}; an ISO stamp brings T and Z.
    expect(remoteId({}, "abcd1234-2026-09-06T22-35-14-636Z.envsnap")).toBe(
      "abcd1234-2026-09-06t22-35-14-636z.envsnap",
    );
  });

  it("applies the scope as a prefix", () => {
    expect(remoteId({ ENVS_REMOTE_SCOPE: "team" }, "a-1.envsnap")).toBe(
      "team-a-1.envsnap",
    );
  });

  it("refuses a name the remote could not carry", () => {
    expect(() => remoteId({}, "../escape")).toThrow(/cannot be named/);
    expect(() => remoteId({}, `${"x".repeat(80)}.envsnap`)).toThrow(
      /cannot be named/,
    );
  });
});

describe("the hosted provider is only offered when it can work", () => {
  it("is not eligible without a sign-in", () => {
    const home = mkdtempSync(join(tmpdir(), "envs-remote-empty-"));
    expect(remoteProvider.eligible({ HOME: home })).toBe(false);
    expect(remoteProvider.describe({ HOME: home })).toMatch(/envs login/);
  });

  it("is eligible with one", () => {
    expect(remoteProvider.eligible({ HOME: signedInHome() })).toBe(true);
  });
});

describe("the hosted provider says which write it is making", () => {
  const base = (home: string) => ({
    HOME: home,
    ENVS_RESOURCE: "https://api.example.test",
  });

  it("creates with if-none-match when the remote has nothing", async () => {
    const sent = stubHub((url, method) => {
      if (url.endsWith("/v1/me"))
        return reply(200, { ok: true, userId: "u1", catalogs: [] });
      if (url.endsWith("/head")) return reply(404, { ok: false });
      if (method === "PUT") return reply(200, { ok: true });
      return reply(500, { ok: false });
    });

    await remoteProvider.put(
      base(signedInHome()),
      "a-1.envsnap",
      new Uint8Array([1, 2, 3]),
    );

    const put = sent.find((call) => call.method === "PUT")!;
    expect(put.url).toBe("https://api.example.test/v1/catalogs/u1/a-1.envsnap");
    expect(put.headers["if-none-match"]).toBe("*");
    expect(put.headers["if-match"]).toBeUndefined();
    // sha256 of the three bytes, computed here rather than by the code.
    expect(put.headers["x-envs-digest"]).toBe(
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
  });

  it("replaces with the version it read, so a race is refused", async () => {
    const sent = stubHub((url, method) => {
      if (url.endsWith("/v1/me"))
        return reply(200, { ok: true, userId: "u1", catalogs: [] });
      if (url.endsWith("/head"))
        return reply(200, { ok: true, version: "a".repeat(64) });
      if (method === "PUT") return reply(200, { ok: true });
      return reply(500, { ok: false });
    });

    await remoteProvider.put(
      base(signedInHome()),
      "a-1.envsnap",
      new Uint8Array([1]),
    );

    const put = sent.find((call) => call.method === "PUT")!;
    expect(put.headers["if-match"]).toBe(`"${"a".repeat(64)}"`);
    expect(put.headers["if-none-match"]).toBeUndefined();
  });

  it("turns a subscription refusal into words, not a status", async () => {
    stubHub((url) =>
      url.endsWith("/v1/me")
        ? reply(200, { ok: true, userId: "u1", catalogs: [] })
        : reply(402, { ok: false, error: "not_entitled" }),
    );

    await expect(
      remoteProvider.put(
        base(signedInHome()),
        "a-1.envsnap",
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/subscription/);
  });

  it("lists only snapshots, and only in scope", async () => {
    stubHub(() =>
      reply(200, {
        ok: true,
        userId: "u1",
        catalogs: [
          { id: "team-a.envsnap", version: "v", bytes: 10, updatedAt: "t" },
          { id: "other-b.envsnap", version: "v", bytes: 20, updatedAt: "t" },
          { id: "team-notes", version: "v", bytes: 30, updatedAt: "t" },
        ],
      }),
    );

    const listed = await remoteProvider.list({
      HOME: signedInHome(),
      ENVS_RESOURCE: "https://api.example.test",
      ENVS_REMOTE_SCOPE: "team",
    });
    expect(listed.map((entry) => entry.name)).toEqual(["team-a.envsnap"]);
    expect(listed[0]!.size).toBe(10);
  });
});

describe("a sign-in renews itself rather than expiring into a re-login", () => {
  const fetcherFor =
    (status: number, body: unknown) =>
    async (): Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }> => ({
      ok: status < 400,
      status,
      json: async () => body,
    });

  const session = {
    issuer: ISSUER,
    accessToken: "old",
    refreshToken: "r1",
    scope: "envs:catalog:read",
  };

  it("exchanges the refresh token for a new access token", async () => {
    const renewed = await refresh(
      metadata,
      session,
      "client",
      fetcherFor(200, { access_token: "new", expires_in: 600 }),
      () => 1_000,
    );
    expect(renewed?.accessToken).toBe("new");
    expect(renewed?.expiresAt).toBe(1_000 + 600_000);
  });

  it("keeps the rotated refresh token, not the spent one", async () => {
    // A server that rotates invalidates the old value; keeping it would sign
    // the machine out on the next renewal.
    const renewed = await refresh(
      metadata,
      session,
      "client",
      fetcherFor(200, { access_token: "new", refresh_token: "r2" }),
    );
    expect(renewed?.refreshToken).toBe("r2");
  });

  it("keeps the previous refresh token when the server does not rotate", async () => {
    const renewed = await refresh(
      metadata,
      session,
      "client",
      fetcherFor(200, { access_token: "new" }),
    );
    expect(renewed?.refreshToken).toBe("r1");
  });

  it("returns nothing when there is no refresh token to spend", async () => {
    const renewed = await refresh(
      metadata,
      { issuer: ISSUER, accessToken: "old" },
      "client",
      fetcherFor(200, { access_token: "new" }),
    );
    expect(renewed).toBeNull();
  });

  it("returns nothing when the server refuses", async () => {
    const renewed = await refresh(
      metadata,
      session,
      "client",
      fetcherFor(400, { error: "invalid_grant" }),
    );
    expect(renewed).toBeNull();
  });

  it("refuses a token endpoint that left the issuer's origin", async () => {
    await expect(
      refresh(
        { ...metadata, token_endpoint: "https://elsewhere.test/token" },
        session,
        "client",
        fetcherFor(200, { access_token: "new" }),
      ),
    ).rejects.toThrow();
  });
});
