import { randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import { ensureCatalogDir } from "../catalog/dir.js";
import { createSchema } from "../catalog/schema.js";
import { writeWraps } from "../catalog/write.js";
import { one, type Command } from "../cli/command.js";
import { createKeyring } from "../crypto/keyring.js";
import { ensureIgnored } from "./hygiene.js";
import { locateCatalogs } from "../loader/locate.js";
import { openDatabaseSync } from "../sqlite/open.js";

const DEFAULT_CODES = 5;

export const initCommand: Command = {
  name: "init",
  describe: "create a catalog and print its recovery codes once",
  usage: "envs init [--recovery-codes <n>] [--no-gitignore]",
  group: "start here",
  options: [
    {
      name: "recovery-codes",
      placeholder: "<n>",
      describe: `how many to mint (default ${DEFAULT_CODES}, 0 for none)`,
    },
    {
      name: "no-gitignore",
      boolean: true,
      describe: "do not touch .gitignore",
    },
  ],

  run({ ui, args, env, cwd }) {
    const located = locateCatalogs({ cwd, env });
    const path = located.project;

    // Re-initialising would mint a new DEK and leave every existing item
    // unreadable, which is the one thing this command must never do quietly.
    if (existsSync(path)) {
      ui.error("a catalog already exists here", path);
      ui.info("nothing was changed", "delete it deliberately to start over");
      return 1;
    }

    const requested = one(args, "recovery-codes");
    const count = requested === undefined ? DEFAULT_CODES : Number(requested);
    if (!Number.isInteger(count) || count < 0 || count > 20) {
      ui.error(`--recovery-codes must be a whole number from 0 to 20`);
      return 2;
    }

    const givenKek = env["ENVS_KEK"] ?? "";
    let kek: Uint8Array;
    let mintedKek = false;
    if (givenKek !== "") {
      kek = new Uint8Array(Buffer.from(givenKek, "base64"));
      if (kek.length !== 32) {
        ui.error("ENVS_KEK must be 32 bytes, base64 encoded");
        return 2;
      }
    } else {
      kek = new Uint8Array(randomBytes(32));
      mintedKek = true;
    }

    const keyring = createKeyring({ kek, recoveryCodes: count });

    const dir = ensureCatalogDir(dirname(path));
    const db = openDatabaseSync(path);
    try {
      createSchema(db);
      writeWraps(db, keyring.wraps);
    } finally {
      db.close();
    }
    // Reinforcement on Linux only; encryption is what actually protects this.
    try {
      chmodSync(path, 0o600);
    } catch {
      /* not every platform has POSIX modes */
    }

    ui.success("catalog created", path);
    // Reported, not silent: this changed a directory the person already had.
    if (dir === "narrowed") {
      ui.warn(
        "narrowed the catalog directory to 700",
        "it was writable by others, who could have replaced the catalog",
      );
    }
    if (located.source === "global") {
      ui.warn(
        "no project root here, so this is the machine-wide catalog",
        located.project,
      );
    }
    if (args.flags.has("no-gitignore")) {
      ui.info("left .gitignore alone", "as asked");
    } else if (located.projectRoot !== undefined) {
      ensureIgnored(located.projectRoot, ui);
    }

    // This is the only time either secret is shown. Neither is stored: the
    // catalog holds wrapped copies of the data key and nothing that can give
    // these back.
    ui.line();
    if (mintedKek) {
      ui.heading("Your key — save it now, it is not stored");
      ui.line(`  ENVS_KEK=${Buffer.from(kek).toString("base64")}`);
      ui.line();
    } else {
      ui.info("used the ENVS_KEK already in your environment", "not reprinted");
    }

    if (keyring.recoveryCodes.length > 0) {
      ui.heading(
        `Recovery codes — ${keyring.recoveryCodes.length}, shown once, not stored`,
      );
      for (const code of keyring.recoveryCodes) ui.line(`  ${code}`);
      ui.line();
      ui.info(
        "any one of them opens this catalog without the key",
        "keep them somewhere the key is not",
      );
    } else {
      ui.warn(
        "no recovery codes were minted",
        "losing ENVS_KEK will lose this catalog",
      );
    }

    ui.line();
    ui.info("next", "envs load <path> to put values in");
    return 0;
  },
};
