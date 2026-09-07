import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matchesGlob, selected } from "../src/catalog/glob.js";
import { readHeader } from "../src/backup/snapshot.js";
import { amzDate, encodePath, signRequest } from "../src/backup/sigv4.js";
import { Ui, type Stream } from "../src/cli/ui.js";
import { dispatch } from "../src/commands/index.js";
import { config } from "../src/loader/config.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const KEK = Buffer.from(new Uint8Array(32).fill(51)).toString("base64");

let dir: string;
let home: string;
let vault: string;
let out: Capture;
let err: Capture;

async function run(
  argv: readonly string[],
  // HOME included: without it these read the machine's own home, and the
  // session checks then answered about the developer's directory.
  env: Record<string, string> = { ENVS_KEK: KEK, HOME: home },
): Promise<number> {
  out = new Capture();
  err = new Capture();
  return dispatch(argv, {
    ui: new Ui({ stdout: out, stderr: err, color: false, env: {} }),
    env,
    cwd: dir,
  });
}

const load = (env: Record<string, string> = { ENVS_KEK: KEK }) =>
  config({ cwd: dir, home, env, processEnv: {} });

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), "envs-wb-"));
  dir = join(base, "project");
  home = join(base, "home");
  vault = join(base, "vault");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  await run(["init", "--recovery-codes", "1"]);
  writeFileSync(join(dir, ".env"), "A=1\nB=two\n");
  await run(["load", ".env"]);
});

afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("glob", () => {
  it("stops a single star at a separator and lets a double star cross", () => {
    expect(matchesGlob("*.env", "prod.env")).toBe(true);
    expect(matchesGlob("*.env", "a/prod.env")).toBe(false);
    expect(matchesGlob("**/*.env", "a/b/prod.env")).toBe(true);
  });

  it("matches zero segments for a separator-bounded double star", () => {
    expect(matchesGlob("**/.env.example", ".env.example")).toBe(true);
    expect(matchesGlob("**/.env.example", "apps/x/.env.example")).toBe(true);
  });

  it("treats a dot as a literal, not as any character", () => {
    expect(matchesGlob(".env", "xenv")).toBe(false);
  });

  it("lets an exclude beat an include", () => {
    expect(selected("a/.env", [".env", "**/.env"], [])).toBe(true);
    expect(selected("a/.env", ["**/.env"], ["a/**"])).toBe(false);
  });
});

describe("watch", () => {
  it("lists the defaults before anything is added", async () => {
    expect(await run(["watch", "list"])).toBe(0);
    expect(err.text).toContain(".env");
    expect(err.text).toContain("node_modules");
  });

  it("finds the files the defaults already cover", async () => {
    expect(await run(["watch", "scan"])).toBe(0);
    expect(err.text).toContain(".env");
  });

  it("leaves an example file out, and a widening include brings it in", async () => {
    writeFileSync(join(dir, ".env.example"), "A=\n");
    await run(["watch", "scan"]);
    expect(err.text).not.toContain(".env.example");
  });

  it("takes an exclude that removes a file from the scan", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", ".env"), "C=3\n");
    await run(["watch", "add", "**/.env"]);
    await run(["watch", "scan"]);
    expect(err.text).toContain("sub/.env");

    await run(["watch", "exclude", "sub/**"]);
    await run(["watch", "scan"]);
    expect(err.text).not.toContain("sub/.env");
  });

  it("warns that a bare directory matches nothing", async () => {
    mkdirSync(join(dir, "conf"), { recursive: true });
    await run(["watch", "add", "conf"]);
    expect(err.text).toContain("matches no file by itself");
  });

  it("refuses the same pattern twice", async () => {
    await run(["watch", "add", "**/.env"]);
    expect(await run(["watch", "add", "**/.env"])).toBe(1);
    expect(err.text).toContain("already a target");
  });

  it("removes one, and says so when there is nothing to remove", async () => {
    await run(["watch", "add", "**/.env"]);
    expect(await run(["watch", "remove", "**/.env"])).toBe(0);
    expect(await run(["watch", "remove", "**/.env"])).toBe(1);
  });

  it("refuses a subcommand it does not have", async () => {
    expect(await run(["watch", "nonsense"])).toBe(2);
  });
});

describe("backup and restore", () => {
  const withVault = (extra: Record<string, string> = {}) => ({
    ENVS_KEK: KEK,
    HOME: home,
    ENVS_BACKUP_DIR: vault,
    ...extra,
  });

  it("writes a snapshot the directory provider can list", async () => {
    expect(await run(["backup"], withVault())).toBe(0);
    expect(err.text).toContain(".envsnap");
    expect(
      readdirSync(vault).filter((n) => n.endsWith(".envsnap")),
    ).toHaveLength(1);

    expect(await run(["restore", "--list"], withVault())).toBe(0);
    expect(err.text).toContain(".envsnap");
  });

  it("keeps the catalog out of the snapshot's readable part", async () => {
    await run(["backup"], withVault());
    const name = readdirSync(vault).find((n) => n.endsWith(".envsnap"))!;
    const bytes = new Uint8Array(readFileSync(join(vault, name)));
    const { header } = readHeader(bytes);
    expect(header.magic).toBe("ENVSNAP1");
    expect(header.wraps.length).toBeGreaterThan(0);
    // The header reads without a key, and still shows no value.
    expect(new TextDecoder().decode(bytes.subarray(0, 400))).not.toContain(
      "two",
    );
  });

  it("restores over a lost catalog and the values come back", async () => {
    await run(["backup"], withVault());
    const name = readdirSync(vault).find((n) => n.endsWith(".envsnap"))!;
    rmSync(join(dir, ".envs"), { recursive: true });
    expect(load().error).toBeDefined();

    expect(await run(["restore", name], withVault())).toBe(0);
    expect(load().parsed).toEqual({ A: "1", B: "two" });
  });

  it("opens with a recovery code alone, which is the point of a backup", async () => {
    await run(["rotate", "--recovery-codes", "1"], withVault());
    const code = /^ {2}([0-9A-Z-]{20,})$/m.exec(err.text)?.[1];
    expect(code).toBeDefined();

    await run(["backup"], withVault());
    const name = readdirSync(vault).find((n) => n.endsWith(".envsnap"))!;
    rmSync(join(dir, ".envs"), { recursive: true });

    // No ENVS_KEK at all: the key is exactly what a backup may have to survive.
    expect(
      await run(["restore", name, "--recovery-code", code!], {
        ENVS_BACKUP_DIR: vault,
      }),
    ).toBe(0);
    expect(load().parsed).toEqual({ A: "1", B: "two" });
  });

  it("refuses to overwrite a catalog, and keeps the old one when forced", async () => {
    await run(["backup"], withVault());
    const name = readdirSync(vault).find((n) => n.endsWith(".envsnap"))!;

    expect(await run(["restore", name], withVault())).toBe(1);
    expect(err.text).toContain("--force");

    await run(["set", "A=changed"]);
    expect(await run(["restore", name, "--force"], withVault())).toBe(0);
    expect(load().parsed?.["A"]).toBe("1");
    expect(
      readdirSync(join(dir, ".envs")).some((n) => n.includes(".replaced-")),
    ).toBe(true);
  });

  it("does not let the replaced database's journal come back with it", async () => {
    await run(["backup"], withVault());
    const name = readdirSync(vault).find((n) => n.endsWith(".envsnap"))!;

    // Write without checkpointing, so a -wal sits beside the catalog.
    await run(["set", "A=after-the-snapshot"]);
    expect(await run(["restore", name, "--force"], withVault())).toBe(0);

    // Checked before anything opens the catalog again: opening it in WAL mode
    // recreates the sidecar, so a later check would be measuring this test.
    expect(existsSync(join(dir, ".envs", "catalog.sqlite-wal"))).toBe(false);
    expect(load().parsed?.["A"]).toBe("1");
  });

  it("refuses bytes that are not a snapshot", async () => {
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "junk.envsnap"), "not a snapshot at all\n");
    expect(await run(["restore", "junk.envsnap", "--force"], withVault())).toBe(
      1,
    );
    expect(err.text).toContain("not a snapshot");
  });

  it("names the destinations when none is configured", async () => {
    expect(
      await run(["restore", "--list"], { ENVS_KEK: KEK, HOME: home }),
    ).toBe(2);
    expect(err.text).toContain("file");
    expect(err.text).toContain("s3");
  });

  it("still lists them when the session directory is not private", async () => {
    // Measured on this machine: a 0775 ~/.envs made every destination listing
    // exit on an unreadable session instead of naming the destinations.
    mkdirSync(join(home, ".envs"), { recursive: true, mode: 0o775 });
    chmodSync(join(home, ".envs"), 0o775);
    expect(
      await run(["restore", "--list"], { ENVS_KEK: KEK, HOME: home }),
    ).toBe(2);
    expect(err.text).toContain("envs");
    expect(err.text).toContain("not private");
  });

  it("takes --to as the directory, without an environment variable", async () => {
    expect(await run(["backup", "--to", vault])).toBe(0);
    expect(
      readdirSync(vault).filter((n) => n.endsWith(".envsnap")),
    ).toHaveLength(1);
  });
});

describe("sigv4", () => {
  // AWS publishes this derivation vector; reproducing it fixes the HMAC ladder
  // and the order of its inputs.
  it("derives the signing key AWS documents", () => {
    const signed = signRequest({
      method: "GET",
      path: "/",
      headers: { host: "iam.amazonaws.com" },
      body: new Uint8Array(0),
      region: "us-east-1",
      service: "iam",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
    });
    expect(signed.stringToSign).toContain(
      "20150830/us-east-1/iam/aws4_request",
    );
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds the canonical request in the documented shape", () => {
    const signed = signRequest({
      method: "PUT",
      path: "/bucket/key.envsnap",
      headers: { host: "s3.amazonaws.com" },
      body: new TextEncoder().encode("body"),
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      now: new Date(Date.UTC(2026, 8, 6, 10, 15, 30)),
    });
    const lines = signed.canonicalRequest.split("\n");
    expect(lines[0]).toBe("PUT");
    expect(lines[1]).toBe("/bucket/key.envsnap");
    expect(lines[2]).toBe("");
    // Headers lower-cased and sorted, then the signed-header list, then the hash.
    expect(signed.canonicalRequest).toContain("host:s3.amazonaws.com\n");
    expect(lines[lines.length - 2]).toBe(
      "host;x-amz-content-sha256;x-amz-date",
    );
  });

  it("puts a session token in the signature when there is one", () => {
    const withToken = signRequest({
      method: "GET",
      path: "/",
      headers: { host: "s3.amazonaws.com" },
      body: new Uint8Array(0),
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOKEN",
      now: new Date(Date.UTC(2026, 8, 6)),
    });
    expect(withToken.canonicalRequest).toContain("x-amz-security-token:TOKEN");
    expect(withToken.headers["authorization"]).toContain(
      "x-amz-security-token",
    );
  });

  it("encodes a path segment but not its separators", () => {
    expect(encodePath("/bucket/a b/c.envsnap")).toBe("/bucket/a%20b/c.envsnap");
  });

  it("writes the timestamp in the basic format", () => {
    expect(amzDate(new Date(Date.UTC(2026, 8, 6, 10, 15, 30)))).toBe(
      "20260906T101530Z",
    );
  });
});
