import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { one, type Command } from "../cli/command.js";
import {
  checkNamespace,
  checkObtain,
  learnNamespaces,
  namespaceOf,
  parseNamespaceMap,
  RESERVED_NAMESPACES,
} from "../template/registry.js";
import { parseTemplate, templateDigest } from "../template/schema.js";

/** registry/<ns>/<name>.json sits two levels under the map it belongs to. */
function nearbyNamespaces(file: string): string | undefined {
  let dir = dirname(resolve(file));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, "namespaces.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * For a publisher, before a template reaches anyone. The same checks the
 * publish gate runs: a rule enforced in one place only is a rule with a way
 * around it.
 */
const isReserved = (name: string): boolean =>
  RESERVED_NAMESPACES.includes(namespaceOf(name));

export const templateCommand: Command = {
  name: "template",
  describe: "check a template before publishing it",
  usage: "envs template lint <file.json>",
  group: "publish",
  options: [
    {
      name: "publisher",
      placeholder: "<name>",
      describe: "who is publishing, for the reserved namespace check",
    },
    {
      name: "namespaces",
      placeholder: "<path>",
      describe: "the namespace allowlist to check against",
    },
  ],

  async run({ ui, args }) {
    const [verb, file] = args.positional;
    if (verb !== "lint") {
      ui.error("say what to do", "envs template lint <file.json>");
      return 2;
    }
    if (file === undefined) {
      ui.error("say which file", "envs template lint <file.json>");
      return 2;
    }
    // A publisher lints against the map they are publishing alongside, not the
    // one their installed CLI happens to carry. Without this a new provider
    // cannot be linted in the same commit that introduces it.
    const map = one(args, "namespaces") ?? nearbyNamespaces(file);
    if (map !== undefined && existsSync(map)) {
      learnNamespaces(parseNamespaceMap(readFileSync(map, "utf8")));
    }
    if (!existsSync(file)) {
      ui.error("no such file", file);
      return 1;
    }

    const payload = readFileSync(file, "utf8");
    try {
      // The declared name keys the obtain allowlist, so it is read before the
      // parse rather than after it.
      const declared = (JSON.parse(payload) as { name?: unknown }).name;
      const name = typeof declared === "string" ? declared : "";
      const template = parseTemplate(payload, {
        allowObtain: (url, at) => {
          checkObtain(name, url, at);
        },
      });
      // Enforced when the publisher is known, which is how the publish gate
      // calls it. Locally the name is not yet a claim, so it is reported
      // rather than refused -- a lint nobody can run is a lint nobody runs.
      const publisher = one(args, "publisher");
      if (publisher !== undefined) {
        checkNamespace(template.name, publisher);
      } else if (isReserved(template.name)) {
        ui.warn(
          `"${namespaceOf(template.name)}" is a reserved namespace`,
          "publishing under it is refused unless we are the publisher",
        );
      }

      const keys = Object.entries(template.keys);
      ui.success(
        `${template.name} v${String(template.version)}`,
        template.title,
      );
      ui.info("digest", await templateDigest(payload));
      ui.info(
        `${String(keys.length)} keys`,
        keys
          .map(([keyName, key]) => `${keyName}${key.required ? "" : "?"}`)
          .join(" "),
      );
      const unpatterned = keys.filter(([, key]) => key.pattern === undefined);
      if (unpatterned.length > 0) {
        // Not a failure: a pattern is optional. But a key without one cannot
        // catch the swap it exists to catch.
        ui.warn(
          `${String(unpatterned.length)} without a pattern`,
          unpatterned.map(([keyName]) => keyName).join(" "),
        );
      }
      return 0;
    } catch (error) {
      ui.error("template refused", (error as Error).message);
      return 1;
    }
  },
};
