import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

import { audit, writeWraps } from "../catalog/write.js";
import { one, type Command } from "../cli/command.js";
import { addWrap, createKeyring, unlockDek } from "../crypto/keyring.js";
import { locateCatalogs } from "../loader/locate.js";
import { readWraps } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import { resolveUnlock } from "./unlock.js";

/**
 * Rotation re-wraps the data key; it does not re-encrypt a single value. That
 * is the point of the two-level hierarchy — a compromised key is replaced in
 * milliseconds rather than by rewriting the catalog.
 */
export const rotateCommand: Command = {
  name: "rotate",
  describe: "replace the key, the recovery codes, or both",
  usage: "envs rotate [--key] [--recovery-codes <n>]",
  group: "history",
  options: [
    {
      name: "key",
      boolean: true,
      describe: "mint a new ENVS_KEK and retire the old wrap",
    },
    {
      name: "recovery-codes",
      placeholder: "<n>",
      describe: "mint this many new codes and retire the old ones",
    },
    {
      name: "recovery-code",
      placeholder: "<code|->",
      describe: "unlock with a recovery code; - reads it from stdin",
    },
  ],

  run({ ui, args, env, cwd }) {
    const wantKey = args.flags.has("key");
    const codesRaw = one(args, "recovery-codes");
    const wantCodes = codesRaw !== undefined;
    if (!wantKey && !wantCodes) {
      ui.error("nothing to rotate", "--key, --recovery-codes <n>, or both");
      return 2;
    }
    const codeCount = wantCodes ? Number(codesRaw) : 0;
    if (
      wantCodes &&
      (!Number.isInteger(codeCount) || codeCount < 1 || codeCount > 20)
    ) {
      ui.error("--recovery-codes must be a whole number from 1 to 20");
      return 2;
    }

    const located = locateCatalogs({ cwd, env });
    if (!existsSync(located.project)) {
      ui.error("no catalog here", located.project);
      ui.info("run envs init first");
      return 1;
    }
    const unlock = resolveUnlock(one(args, "recovery-code"), env);
    if (typeof unlock === "string") {
      ui.error(unlock);
      return 2;
    }

    const db = openDatabaseSync(located.project);
    try {
      const before = readWraps(db);
      const dek = unlockDek(before, unlock);

      const added: string[] = [];
      let newKek: Uint8Array | undefined;
      let newCodes: readonly string[] = [];

      if (wantKey) {
        newKek = new Uint8Array(randomBytes(32));
        const wrap = addWrap(dek, { kek: newKek }, crypto.randomUUID());
        writeWraps(db, [wrap]);
        added.push(wrap.wrapId);
      }
      if (wantCodes) {
        // Same DEK, new wraps: minting a fresh keyring would make a new DEK and
        // orphan every value in the catalog.
        const minted = createKeyring({ kek: dek, recoveryCodes: codeCount });
        newCodes = minted.recoveryCodes;
        const wraps = minted.recoveryCodes.map((code) =>
          addWrap(dek, { recoveryCode: code }, crypto.randomUUID()),
        );
        writeWraps(db, wraps);
        added.push(...wraps.map((wrap) => wrap.wrapId));
      }

      // Retiring after the replacements exist: a crash between the two leaves a
      // catalog with too many ways in, never with none.
      db.transaction(() => {
        const retire = db.prepare(
          "UPDATE dek_wraps SET retired_at = $at WHERE wrap_id = $id",
        );
        const at = new Date().toISOString();
        for (const wrap of before) {
          const stale =
            (wantKey && wrap.method === "kek") ||
            (wantCodes && wrap.method === "recovery");
          if (stale) retire.run({ at, id: wrap.wrapId });
        }
        audit(
          db,
          "keyring.rotate",
          added.join(" "),
          `retired ${before.length}`,
        );
      });

      ui.success(
        "rotated",
        `${added.length} new wraps, ${before.length} retired`,
      );
      ui.line();
      if (newKek !== undefined) {
        ui.heading("Your new key — save it now, it is not stored");
        ui.line(`  ENVS_KEK=${Buffer.from(newKek).toString("base64")}`);
        ui.line();
        ui.warn("the old ENVS_KEK no longer opens this catalog");
      }
      if (newCodes.length > 0) {
        ui.heading(`New recovery codes — ${newCodes.length}, shown once`);
        for (const code of newCodes) ui.line(`  ${code}`);
        ui.line();
        ui.warn("the old codes no longer open this catalog");
      }
      return 0;
    } catch (error) {
      ui.error((error as Error).message);
      return 1;
    } finally {
      db.close();
    }
  },
};
