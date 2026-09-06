import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { readMeta } from "../catalog/schema.js";
import { one, type Command } from "../cli/command.js";
import type { Ui } from "../cli/ui.js";
import { locateCatalogs } from "../loader/locate.js";
import { openDatabaseSync } from "../sqlite/open.js";

/**
 * Serves the catalog as bytes, not as values. It holds no key and cannot
 * decrypt anything, so a compromised server gives up exactly what a stolen
 * catalog file would — and the client still needs a key or a recovery code.
 */
export interface ServeOptions {
  readonly catalogPath: string;
  readonly token: string;
  readonly port: number;
  readonly host: string;
  readonly ui: Ui;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compare lengths first, then bytes: timingSafeEqual throws on a mismatch.
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorised(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return constantTimeEqual(header.slice(prefix.length), token);
}

function snapshotBytes(catalogPath: string): Uint8Array {
  const db = openDatabaseSync(catalogPath);
  try {
    // The WAL has to reach the main file, or a puller gets a database missing
    // its most recent writes.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return new Uint8Array(readFileSync(catalogPath));
}

/**
 * Returns whether the catalog was actually handed over. --once waits for that
 * rather than for any request: an unauthorised probe must not end a one-shot
 * pull before the client with the token arrives.
 */
export function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServeOptions,
): boolean {
  const url = request.url ?? "/";

  if (url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return false;
  }

  if (!authorised(request.headers.authorization, options.token)) {
    // The same answer for a missing token and a wrong one: telling them apart
    // turns this into an oracle for guessing.
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorised" }));
    return false;
  }

  if (url === "/v1/meta") {
    const db = openDatabaseSync(options.catalogPath, { readOnly: true });
    try {
      const meta = readMeta(db);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(meta ?? { error: "no schema" }));
    } finally {
      db.close();
    }
    return false;
  }

  if (url === "/v1/catalog" && request.method === "GET") {
    const bytes = snapshotBytes(options.catalogPath);
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
    });
    response.end(Buffer.from(bytes));
    options.ui.info("served the catalog", `${bytes.length} bytes`);
    return true;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
  return false;
}

export const serveCommand: Command = {
  name: "serve",
  describe: "hand the sealed catalog to teammates over HTTP",
  usage: "envs serve [--port <n>] [--host <addr>]",
  options: [
    { name: "port", placeholder: "<n>", describe: "default 7373" },
    {
      name: "host",
      placeholder: "<addr>",
      describe: "default 127.0.0.1; anything else exposes it",
    },
    {
      name: "once",
      boolean: true,
      describe: "stop after handing the catalog over once, for a scripted pull",
    },
  ],

  async run({ ui, args, env, cwd }) {
    const located = locateCatalogs({ cwd, env });
    if (!existsSync(located.project)) {
      ui.error("no catalog here", located.project);
      return 1;
    }

    const token = env["ENVS_SERVE_TOKEN"] ?? "";
    if (token.length < 16) {
      // A short token on a network listener is the whole security of this
      // endpoint, so it is required rather than generated quietly.
      ui.error(
        "set ENVS_SERVE_TOKEN to at least 16 characters",
        "clients send it as Authorization: Bearer <token>",
      );
      return 2;
    }

    const port = Number(one(args, "port") ?? 7373);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ui.error("--port must be a port number");
      return 2;
    }
    const host = one(args, "host") ?? "127.0.0.1";

    const options: ServeOptions = {
      catalogPath: located.project,
      token,
      port,
      host,
      ui,
    };

    return new Promise<number>((resolveRun) => {
      const server = createServer((request, response) => {
        let served = false;
        try {
          served = handle(request, response, options);
        } catch (error) {
          ui.error((error as Error).message);
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "failed" }));
        }
        if (served && args.flags.has("once")) {
          server.close(() => resolveRun(0));
        }
      });

      server.on("error", (error: Error) => {
        ui.error(error.message);
        resolveRun(1);
      });

      server.listen(port, host, () => {
        ui.success(`listening on http://${host}:${port}`, located.project);
        ui.info("it serves the sealed catalog", "clients still need a key");
        if (host !== "127.0.0.1" && host !== "localhost") {
          ui.warn(
            "this is reachable from the network",
            "put TLS in front of it: the token crosses the wire",
          );
        }
        ui.info("stop with ctrl-c");
      });

      const stop = (): void => {
        server.close(() => resolveRun(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  },
};
