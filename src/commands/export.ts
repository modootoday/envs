import { exportValues, type ExportFormat } from "../catalog/export.js";
import { many, one, type Command } from "../cli/command.js";
import { resolveUnlock } from "./unlock.js";

const FORMATS: ReadonlySet<string> = new Set(["csv", "env", "json", "shell"]);

export const exportCommand: Command = {
  name: "export",
  describe: "decrypt the catalog and print its values",
  usage: "envs export --yes [--format csv|env|json|shell] [--recovery-code -]",
  options: [
    { name: "yes", boolean: true, describe: "required: this prints secrets" },
    {
      name: "format",
      placeholder: "<fmt>",
      describe: "csv (default), env, json or shell",
    },
    {
      name: "recovery-code",
      placeholder: "<code|->",
      describe: "unlock with a recovery code; - reads it from stdin",
    },
    {
      name: "alias",
      placeholder: "<name>",
      repeat: true,
      describe: "restrict to one source; repeatable",
    },
    {
      name: "revision",
      placeholder: "<id>",
      describe: "a release other than the current",
    },
    { name: "include-global", boolean: true, describe: "also read ~/.envs" },
  ],

  run({ ui, args, env, cwd }) {
    // Printing values is the exception this package makes; it is not what a
    // mistyped command should do.
    if (!args.flags.has("yes")) {
      ui.error(
        "export prints decrypted values to stdout",
        "re-run with --yes if that is what you want",
      );
      return 2;
    }

    const format = one(args, "format") ?? "csv";
    if (!FORMATS.has(format)) {
      ui.error(`unknown format "${format}"`, "use csv, env, json or shell");
      return 2;
    }

    const code = one(args, "recovery-code");
    if (code !== undefined && code !== "-") {
      ui.warn(
        "a recovery code on the command line is visible to other processes",
        "prefer --recovery-code - and pipe it in",
      );
    }

    const unlock = resolveUnlock(code, env);
    if (typeof unlock === "string") {
      ui.error(unlock);
      return 2;
    }

    const aliases = many(args, "alias");
    const revision = one(args, "revision");

    try {
      const result = exportValues({
        unlock,
        cwd,
        env,
        format: format as ExportFormat,
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(revision ? { revisionId: revision } : {}),
        includeGlobal: args.flags.has("include-global"),
      });
      ui.data(result.text);
      ui.success(`exported ${result.count} values`, result.catalogs.join(", "));
      if (result.formulaKeys.length > 0) {
        ui.warn(
          "a spreadsheet will evaluate these rather than display them",
          `value starts with = + - or @: ${result.formulaKeys.join(", ")}`,
        );
      }
      return 0;
    } catch (error) {
      ui.error((error as Error).message);
      return 1;
    }
  },
};
