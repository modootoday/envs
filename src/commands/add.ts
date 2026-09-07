import { existsSync, readFileSync } from "node:fs";

import { one, type Command } from "../cli/command.js";
import { hashKeyName } from "../crypto/envelope.js";
import { unlockDek } from "../crypto/keyring.js";
import { locateCatalogs } from "../loader/locate.js";
import { readWraps } from "../loader/read.js";
import { openDatabaseSync } from "../sqlite/open.js";
import {
  DEFAULT_REGISTRY,
  fetchTemplate,
  looksLikeName,
  templateUrl,
} from "../template/fetch.js";
import { checkObtain } from "../template/registry.js";
import {
  parseTemplate,
  templateDigest,
  type Sensitivity as TemplateSensitivity,
  type Template,
} from "../template/schema.js";
import { recordTemplate } from "../template/store.js";
import type { Sensitivity } from "./build.js";
import { resolveUnlock } from "./unlock.js";

/**
 * The publisher's two words and the catalog's four are different vocabularies.
 * Mapped here and nowhere else, because writing "secret" into a column that
 * validates low|medium|high|critical is how a classification stops meaning
 * anything.
 */
const CATALOG_LEVEL: Readonly<Record<TemplateSensitivity, Sensitivity>> = {
  secret: "high",
  config: "low",
};

export async function loadTemplate(
  source: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<{ template: Template; payload: string; from: string }> {
  // A path wins over a name, so a file that exists is never shadowed by
  // something the registry happens to serve under the same spelling.
  let payload: string;
  let from: string;
  if (existsSync(source)) {
    payload = readFileSync(source, "utf8");
    from = source;
  } else if (looksLikeName(source)) {
    const registry = env["ENVS_REGISTRY"] ?? DEFAULT_REGISTRY;
    payload = await fetchTemplate(source, registry);
    from = templateUrl(source, registry);
  } else {
    throw new Error(
      `no template at ${source}; pass a file or a publisher/template name`,
    );
  }
  const template = parseTemplate(payload, {
    allowObtain: (url, at) => {
      // Read the name first so the allowlist is the publisher's own, not the
      // one the file would like to claim.
      const name = (JSON.parse(payload) as { name?: unknown }).name;
      checkObtain(typeof name === "string" ? name : "", url, at);
    },
  });
  return { template, payload, from };
}

export const addCommand: Command = {
  name: "add",
  describe: "declare the keys a template names, without setting any value",
  usage: "envs add <publisher/template | template.json>",
  group: "start here",
  options: [
    {
      name: "recovery-code",
      placeholder: "<code|->",
      describe: "unlock with a recovery code; - reads it from stdin",
    },
  ],

  async run({ ui, args, env, cwd }) {
    const source = args.positional[0];
    if (source === undefined) {
      ui.error(
        "say which template",
        "envs add <publisher/template | template.json>",
      );
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

    let loaded: { template: Template; payload: string; from: string };
    try {
      loaded = await loadTemplate(source, env);
    } catch (error) {
      ui.error("template refused", (error as Error).message);
      return 1;
    }
    const { template, payload } = loaded;

    // Computed before the transaction, which is synchronous.
    const digest = await templateDigest(payload);

    const db = openDatabaseSync(located.project);
    try {
      const dek = unlockDek(readWraps(db), unlock);
      const now = new Date().toISOString();
      const declared: string[] = [];
      const already: string[] = [];

      db.transaction(() => {
        for (const [name, key] of Object.entries(template.keys)) {
          const hash = hashKeyName(dek, name);
          const existing = db
            .prepare<{ key_hash: Uint8Array }>(
              "SELECT key_hash FROM keys WHERE key_hash = $hash",
            )
            .get({ hash });
          if (existing) {
            // Reported, never touched: a template must not reclassify or
            // overwrite a value someone already set.
            already.push(name);
            continue;
          }
          db.prepare(
            `INSERT INTO keys (key_hash, first_seen_at, sensitivity)
               VALUES ($hash, $at, $level)`,
          ).run({
            hash,
            at: now,
            level: CATALOG_LEVEL[key.sensitivity],
          });
          declared.push(name);
        }
        recordTemplate(db, {
          name: template.name,
          version: template.version,
          digest,
          payload,
          appliedAt: now,
        });
      });

      ui.success(
        `${template.name} v${String(template.version)}`,
        template.title,
      );
      if (declared.length > 0) {
        ui.info(`declared ${String(declared.length)}`, declared.join(" "));
      }
      if (already.length > 0) {
        ui.info(`already present ${String(already.length)}`, already.join(" "));
      }
      // No value was written. Saying so is the point: the keys are known and
      // still unset, which is exactly what doctor will now report.
      ui.info("no values were set", "envs doctor says which are still missing");
      return 0;
    } catch (error) {
      ui.error((error as Error).message);
      return 1;
    } finally {
      db.close();
    }
  },
};
