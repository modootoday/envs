import { existsSync, readFileSync } from "node:fs";

import { one, type Command } from "../cli/command.js";
import {
  checkNamespace,
  checkObtain,
  namespaceOf,
  RESERVED_NAMESPACES,
} from "../template/registry.js";
import { parseTemplate, templateDigest } from "../template/schema.js";

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
  options: [
    {
      name: "publisher",
      placeholder: "<name>",
      describe: "who is publishing, for the reserved namespace check",
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
      ui.success(`${template.name} v${String(template.version)}`, template.title);
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
