import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clearSession,
  discover,
  pollOnce,
  readSession,
  revoke,
  startDevice,
  writeSession,
  type Fetcher,
  type IssuerMetadata,
} from "../src/remote/session.js";

const ISSUER = "https://auth.example.test";

const metadata: IssuerMetadata = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/api/oauth/token`,
  device_authorization_endpoint: `${ISSUER}/api/oauth/device_authorization`,
  revocation_endpoint: `${ISSUER}/api/oauth/revoke`,
  grant_types_supported: [
    "authorization_code",
    "urn:ietf:params:oauth:grant-type:device_code",
  ],
};

const replies = (
  entries: Record<string, { status: number; body: unknown }[]>,
): { fetcher: Fetcher; seen: string[] } => {
  const seen: string[] = [];
  const queues = new Map(Object.entries(entries).map(([k, v]) => [k, [...v]]));
  const fetcher: Fetcher = async (url, init) => {
    seen.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`.trim());
    const queue = queues.get(url);
    const next = queue?.shift();
    if (!next) throw new Error(`no reply queued for ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { fetcher, seen };
};

describe("the issuer is asked rather than assumed", () => {
  it("reads the endpoints out of discovery", async () => {
    const { fetcher } = replies({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: [
        { status: 200, body: metadata },
      ],
    });
    expect((await discover(ISSUER, fetcher)).token_endpoint).toBe(
      metadata.token_endpoint,
    );
  });

  it("refuses an issuer that advertises no device grant", async () => {
    const { fetcher } = replies({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: [
        {
          status: 200,
          body: { ...metadata, grant_types_supported: ["authorization_code"] },
        },
      ],
    });
    await expect(discover(ISSUER, fetcher)).rejects.toThrow(/device grant/);
  });
});

describe("the device request sends what the hub demands", () => {
  it("carries client_id, resource and scope", async () => {
    const { fetcher, seen } = replies({
      [metadata.device_authorization_endpoint]: [
        {
          status: 200,
          body: {
            device_code: "dc",
            user_code: "ABCD-EFGH",
            verification_uri: `${ISSUER}/oauth/device`,
            interval: 3,
            expires_in: 300,
          },
        },
      ],
    });
    const start = await startDevice(
      metadata,
      { clientId: "cid", resource: "https://api", scope: "a b" },
      fetcher,
      () => 1000,
    );
    expect(start.userCode).toBe("ABCD-EFGH");
    expect(start.intervalMs).toBe(3000);
    expect(start.expiresAt).toBe(1000 + 300_000);
    expect(seen[0]).toContain("client_id=cid");
    expect(seen[0]).toContain("resource=https%3A%2F%2Fapi");
    expect(seen[0]).toContain("scope=a+b");
  });
});

describe("polling reads the error the spec defines", () => {
  const poll = async (status: number, body: unknown) => {
    const { fetcher } = replies({
      [metadata.token_endpoint]: [{ status, body }],
    });
    return pollOnce(
      metadata,
      { clientId: "cid", deviceCode: "dc", issuer: ISSUER },
      fetcher,
      () => 1000,
    );
  };

  it("keeps waiting while the grant is pending", async () => {
    expect((await poll(400, { error: "authorization_pending" })).kind).toBe(
      "pending",
    );
  });

  it("backs off when told to", async () => {
    expect((await poll(400, { error: "slow_down" })).kind).toBe("slow_down");
  });

  it("stops on a denial and on an expiry", async () => {
    expect((await poll(400, { error: "access_denied" })).kind).toBe("denied");
    expect((await poll(400, { error: "expired_token" })).kind).toBe("expired");
  });

  it("keeps the token and when it runs out", async () => {
    const outcome = await poll(200, {
      access_token: "tok",
      expires_in: 60,
      scope: "catalog.read",
    });
    expect(outcome.kind).toBe("granted");
    expect(outcome.session?.accessToken).toBe("tok");
    expect(outcome.session?.expiresAt).toBe(1000 + 60_000);
  });
});

describe("OAuth credential boundaries", () => {
  it("rejects cross-origin discovered token endpoints", async () => {
    const { fetcher } = replies({ [`${ISSUER}/.well-known/oauth-authorization-server`]: [{ status: 200, body: { ...metadata, token_endpoint: "https://evil.test/token" } }] });
    await expect(discover(ISSUER, fetcher)).rejects.toThrow(/issuer origin/);
  });
  it("revokes both credentials even when refresh revocation fails", async () => {
    const { fetcher, seen } = replies({ [metadata.revocation_endpoint!]: [{ status: 500, body: {} }, { status: 200, body: {} }] });
    expect(await revoke(metadata, { issuer: ISSUER, accessToken: "access", refreshToken: "refresh" }, "cid", fetcher)).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("token=refresh");
    expect(seen[1]).toContain("token=access");
  });
});

describe("the stored session is a credential", () => {
  it("replaces an existing permissive regular file with mode 600", () => {
    const home = mkdtempSync(join(tmpdir(), "envs-session-"));
    writeSession({ issuer: ISSUER, accessToken: "old" }, home);
    const path = join(home, ".envs", "session.json");
    chmodSync(path, 0o644);
    expect(() => readSession(home)).toThrow(/unsafe/);
    writeSession({ issuer: ISSUER, accessToken: "new" }, home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSession(home)?.accessToken).toBe("new");
  });
  it("does not follow a credential symlink", () => {
    const home = mkdtempSync(join(tmpdir(), "envs-session-"));
    mkdirSync(join(home, ".envs"), { mode: 0o700 });
    const target = join(home, "target");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(home, ".envs", "session.json"));
    expect(() => writeSession({ issuer: ISSUER, accessToken: "tok" }, home)).toThrow(/unsafe/);
    expect(() => readSession(home)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
    clearSession(home);
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });
  it("rejects symlink directories and surfaces failed deletion", () => {
    const home = mkdtempSync(join(tmpdir(), "envs-session-"));
    const target = mkdtempSync(join(tmpdir(), "envs-session-"));
    symlinkSync(target, join(home, ".envs"));
    expect(() => writeSession({ issuer: ISSUER, accessToken: "tok" }, home)).toThrow(/unsafe/);
    expect(() => clearSession(home)).toThrow(/unsafe/);
  });
  it("is written for this user only", () => {
    const home = mkdtempSync(join(tmpdir(), "envs-session-"));
    writeSession({ issuer: ISSUER, accessToken: "tok" }, home);
    const path = join(home, ".envs", "session.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("tok");
    expect(readSession(home)?.accessToken).toBe("tok");
    clearSession(home);
    expect(readSession(home)).toBeNull();
  });

  it("reads as signed out when there is nothing there", () => {
    const home = mkdtempSync(join(tmpdir(), "envs-session-"));
    expect(readSession(home)).toBeNull();
    // Forgetting what was already forgotten is the outcome logout asks for.
    expect(() => clearSession(home)).not.toThrow();
  });
});
