import { readFileSync } from "node:fs";

import type { Command } from "../cli/command.js";
import { parseEnv } from "../format/parse.js";

export const validateCommand: Command = {
  name: "validate",
  describe: "check that files are env format",
  usage: "envs validate <path>...",
  group: "check",

  run({ ui, args }) {
    if (args.positional.length === 0) {
      ui.error("no paths given", "envs validate <path>...");
      return 2;
    }

    let failed = 0;
    for (const path of args.positional) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        ui.error(path, (error as Error).message);
        failed += 1;
        continue;
      }
      const result = parseEnv(text);
      if (result.ok) {
        const keys = result.entries.filter(
          (e) => e.kind === "assignment",
        ).length;
        ui.success(path, `${keys} keys`);
        continue;
      }
      failed += 1;
      ui.error(path, `${result.findings.length} problems`);
      // Line and kind only. A value is never printed, not even to explain one.
      ui.table(
        result.findings.map((finding) => [
          `line ${finding.line}`,
          finding.code,
        ]),
        "    ",
      );
    }
    return failed === 0 ? 0 : 1;
  },
};
