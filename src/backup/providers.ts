import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  BackupError,
  register,
  type BackupProvider,
  type Env,
  type StoredSnapshot,
} from "./provider.js";
import { encodePath, signRequest } from "./sigv4.js";

/** A directory. Always available, which is what makes a default possible. */
export const fileProvider: BackupProvider = {
  name: "file",

  describe: (env) => {
    const given = env["ENVS_BACKUP_DIR"];
    return given === undefined || given === ""
      ? "needs ENVS_BACKUP_DIR or --to <dir>"
      : `writes to ${resolve(given)}`;
  },
  eligible: (env) => (env["ENVS_BACKUP_DIR"] ?? "") !== "",

  async put(env, name, bytes) {
    const dir = directoryOf(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), bytes, { mode: 0o600 });
  },

  async get(env, name) {
    return new Uint8Array(readFileSync(join(directoryOf(env), name)));
  },

  async list(env) {
    const dir = directoryOf(env);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(".envsnap"))
      .map((name) => {
        const info = statSync(join(dir, name));
        return {
          name,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        } satisfies StoredSnapshot;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  },
};

function directoryOf(env: Env): string {
  const given = env["ENVS_BACKUP_DIR"];
  if (given === undefined || given === "") {
    throw new BackupError(
      "set ENVS_BACKUP_DIR to a directory, or pass --to <dir>",
    );
  }
  return isAbsolute(given) ? given : resolve(given);
}

interface S3Config {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly prefix: string;
}

/**
 * Any endpoint that speaks S3: AWS, R2, MinIO, Backblaze. One provider rather
 * than one per vendor, because what differs between them is a hostname.
 */
function s3Config(env: Env): S3Config | undefined {
  const bucket = env["ENVS_BACKUP_BUCKET"] ?? "";
  const accessKeyId =
    env["ENVS_BACKUP_ACCESS_KEY_ID"] ?? env["AWS_ACCESS_KEY_ID"] ?? "";
  const secretAccessKey =
    env["ENVS_BACKUP_SECRET_ACCESS_KEY"] ?? env["AWS_SECRET_ACCESS_KEY"] ?? "";
  if (bucket === "" || accessKeyId === "" || secretAccessKey === "") {
    return undefined;
  }
  const region = env["ENVS_BACKUP_REGION"] ?? env["AWS_REGION"] ?? "us-east-1";
  const endpoint =
    env["ENVS_BACKUP_ENDPOINT"] ?? `https://s3.${region}.amazonaws.com`;
  const token = env["ENVS_BACKUP_SESSION_TOKEN"] ?? env["AWS_SESSION_TOKEN"];
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    ...(token !== undefined && token !== "" ? { sessionToken: token } : {}),
    prefix: (env["ENVS_BACKUP_PREFIX"] ?? "").replace(/^\/+|\/+$/g, ""),
  };
}

async function s3Send(
  config: S3Config,
  method: string,
  key: string,
  body: Uint8Array,
  query: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(`${config.endpoint}/${config.bucket}${key}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  const signed = signRequest({
    method,
    path: encodePath(url.pathname),
    query,
    headers: { host: url.host },
    body,
    region: config.region,
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  });
  const response = await fetch(url, {
    method,
    headers: signed.headers,
    ...(method === "PUT" ? { body } : {}),
  });
  if (!response.ok) {
    // The body carries the reason; a bare status turns a permissions problem
    // into a mystery.
    throw new BackupError(
      `${method} ${url.pathname} failed: ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  }
  return response;
}

export const s3Provider: BackupProvider = {
  name: "s3",

  describe: (env) =>
    s3Config(env) === undefined
      ? "needs ENVS_BACKUP_BUCKET and credentials"
      : `writes to ${s3Config(env)!.endpoint}/${s3Config(env)!.bucket}`,

  eligible: (env) => s3Config(env) !== undefined,

  async put(env, name, bytes) {
    const config = s3Config(env)!;
    await s3Send(config, "PUT", keyFor(config, name), bytes);
  },

  async get(env, name) {
    const config = s3Config(env)!;
    const response = await s3Send(
      config,
      "GET",
      keyFor(config, name),
      new Uint8Array(0),
    );
    return new Uint8Array(await response.arrayBuffer());
  },

  async list(env) {
    const config = s3Config(env)!;
    const response = await s3Send(config, "GET", "", new Uint8Array(0), {
      "list-type": "2",
      ...(config.prefix === "" ? {} : { prefix: `${config.prefix}/` }),
    });
    const xml = await response.text();
    // A dependency-free reader of exactly the two fields wanted; anything more
    // structured than this belongs to an XML parser, and this is not that.
    const out: StoredSnapshot[] = [];
    for (const block of xml.split("<Contents>").slice(1)) {
      const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
      if (key === undefined || !key.endsWith(".envsnap")) continue;
      out.push({
        name: key.slice(key.lastIndexOf("/") + 1),
        size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
        ...(/<LastModified>([^<]*)<\/LastModified>/.exec(block)?.[1]
          ? {
              modifiedAt: /<LastModified>([^<]*)<\/LastModified>/.exec(
                block,
              )![1]!,
            }
          : {}),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
};

function keyFor(config: S3Config, name: string): string {
  return config.prefix === "" ? `/${name}` : `/${config.prefix}/${name}`;
}

// Order is the fallback order: a configured object store wins over a directory.
register(s3Provider);
register(fileProvider);
