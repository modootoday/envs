import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Ui, type Stream } from "../src/cli/ui.js";
import { dispatch } from "../src/commands/index.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const ISSUER = "https://auth.example.test";
const RESOURCE = "https://api.example.test";

function signedInHome(): string {
  const home = mkdtempSync(join(tmpdir(), "envs-team-"));
  mkdirSync(join(home, ".envs"), { mode: 0o700 });
  writeFileSync(
    join(home, ".envs", "session.json"),
    JSON.stringify({
      issuer: ISSUER,
      accessToken: "envs_access_test",
      expiresAt: Date.now() + 3_600_000,
      scope: "envs:catalog:read envs:team:manage",
    }),
    { mode: 0o600 },
  );
  return home;
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubHub(routes: (url: string, method: string) => Response): {
  sent: Sent[];
} {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body
      ? new TextDecoder().decode(init.body as ArrayBuffer)
      : "";
    sent.push({ url, method, body });
    return routes(url, method);
  }) as typeof fetch;
  return { sent };
}

const ME = {
  ok: true,
  userId: "owner-1",
  subscription: "active",
  allowances: [],
  members: ["mate-1", "mate-2"],
  teams: [],
  catalogs: [],
  capabilities: { cliSignIn: true, teamManagement: true },
};

let out: Capture;
let err: Capture;

async function team(argv: readonly string[], home: string): Promise<number> {
  out = new Capture();
  err = new Capture();
  return dispatch(["team", ...argv], {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env: { HOME: home, ENVS_RESOURCE: RESOURCE },
    cwd: home,
  });
}

describe("envs team", () => {
  it("lists the members the hub reports", async () => {
    const home = signedInHome();
    stubHub(() => new Response(JSON.stringify(ME)));
    expect(await team(["ls"], home)).toBe(0);
    expect(err.text).toContain("mate-1");
    expect(err.text).toContain("mate-2");
  });

  it("says so when the plan does not carry sharing", async () => {
    const home = signedInHome();
    stubHub(
      () =>
        new Response(
          JSON.stringify({
            ...ME,
            capabilities: { cliSignIn: true, teamManagement: false },
          }),
        ),
    );
    expect(await team(["ls"], home)).toBe(0);
    expect(err.text).toContain("not on this plan");
  });

  it("prints the invite on stdout, and says the key travels separately", async () => {
    // The code is the answer, so it can be piped; the key is the part the
    // invite deliberately does not carry.
    const home = signedInHome();
    const code = "a".repeat(40);
    stubHub(
      () =>
        new Response(
          JSON.stringify({ ok: true, invite: code, expiresAt: "2026-09-08" }),
          { status: 201 },
        ),
    );
    expect(await team(["invite"], home)).toBe(0);
    expect(out.text).toBe(`${code}\n`);
    expect(err.text).toContain("ENVS_KEK");
  });

  it("sends the code as a body rather than in the path", async () => {
    const home = signedInHome();
    const { sent } = stubHub(
      () => new Response(JSON.stringify({ ok: true, owner: "owner-1" })),
    );
    expect(await team(["join", "b".repeat(40)], home)).toBe(0);
    expect(sent[0]?.url).toBe(`${RESOURCE}/v1/invites/accept`);
    expect(sent[0]?.url).not.toContain("bbbb");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({
      invite: "b".repeat(40),
    });
  });

  it("tells the owner to rotate after a removal", async () => {
    const home = signedInHome();
    const { sent } = stubHub(() => new Response(JSON.stringify({ ok: true })));
    expect(await team(["remove", "mate-1"], home)).toBe(0);
    expect(sent[0]?.method).toBe("DELETE");
    expect(sent[0]?.url).toBe(`${RESOURCE}/v1/members/mate-1`);
    expect(err.text).toContain("rotate the key");
  });

  it("reports a refusal in the hub's own words", async () => {
    const home = signedInHome();
    stubHub(
      () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            requestId: "req-9",
            error: { code: "NOT_ENTITLED", message: "no", retryable: false },
          }),
          { status: 402 },
        ),
    );
    expect(await team(["invite"], home)).toBe(1);
    expect(err.text).toContain("subscription");
  });

  it("refuses a subcommand it does not have", async () => {
    const home = signedInHome();
    expect(await team(["nope"], home)).toBe(2);
    expect(err.text).toContain("envs team");
  });

  it("asks for the code rather than sending an empty one", async () => {
    const home = signedInHome();
    const { sent } = stubHub(() => new Response("{}"));
    expect(await team(["join"], home)).toBe(2);
    expect(sent).toHaveLength(0);
  });
});
