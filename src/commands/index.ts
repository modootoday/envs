import {
  ArgumentError,
  parseArgs,
  printCommandHelp,
  printHelp,
  type Command,
} from "../cli/command.js";
import { Ui } from "../cli/ui.js";
import { addCommand } from "./add.js";
import { exportCommand } from "./export.js";
import { delCommand } from "./del.js";
import { migrateCommand } from "./migrate.js";
import { templateCommand } from "./template.js";
import { backupCommand, restoreCommand } from "./backup.js";
import { buildCommand } from "./build.js";
import { doctorCommand } from "./doctor.js";
import { getCommand } from "./get.js";
import {
  genexampleCommand,
  gitignoreCommand,
  precommitCommand,
} from "./hygiene.js";
import { historyCommand, rollbackCommand } from "./history.js";
import { lsCommand } from "./ls.js";
import { initCommand } from "./init.js";
import { loadCommand } from "./load.js";
import { rotateCommand } from "./rotate.js";
import { runCommand } from "./run.js";
import { serveCommand } from "./serve.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./session.js";
import { setCommand } from "./set.js";
import { teamCommand } from "./team.js";
import { validateCommand } from "./validate.js";
import { watchCommand } from "./watch.js";

export const COMMANDS: readonly Command[] = [
  initCommand,
  addCommand,
  loadCommand,
  setCommand,
  getCommand,
  delCommand,
  lsCommand,
  runCommand,
  validateCommand,
  doctorCommand,
  historyCommand,
  rollbackCommand,
  exportCommand,
  rotateCommand,
  genexampleCommand,
  gitignoreCommand,
  precommitCommand,
  watchCommand,
  backupCommand,
  restoreCommand,
  buildCommand,
  serveCommand,
  templateCommand,
  migrateCommand,
  loginCommand,
  logoutCommand,
  whoamiCommand,
  teamCommand,
];

/** Named so an unknown verb can say "designed, not built" rather than "unknown". */
/** Empty: every verb the design named is built. */
export const PLANNED: readonly string[] = [];

export interface DispatchOptions {
  readonly ui?: Ui;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

export function dispatch(
  argv: readonly string[],
  options: DispatchOptions = {},
): number | Promise<number> {
  const ui = options.ui ?? new Ui();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const [verb, ...rest] = argv;

  if (verb === undefined) {
    printHelp(ui, COMMANDS, PLANNED);
    return 2;
  }
  if (verb === "--help" || verb === "-h" || verb === "help") {
    const named = COMMANDS.find((command) => command.name === rest[0]);
    if (named) printCommandHelp(ui, named);
    else printHelp(ui, COMMANDS, PLANNED);
    return 0;
  }

  const command = COMMANDS.find((candidate) => candidate.name === verb);
  if (command === undefined) {
    if (PLANNED.includes(verb)) {
      ui.error(`"${verb}" is designed but not implemented yet`);
    } else {
      ui.error(`unknown command "${verb}"`);
    }
    printHelp(ui, COMMANDS, PLANNED);
    return 2;
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    printCommandHelp(ui, command);
    return 0;
  }

  // A command that throws is still a command answering a person. Anything
  // uncaught reaches a terminal as a stack trace, which reads as a crash even
  // when the refusal was deliberate, so the last word is always a message.
  const refuse = (error: unknown): number => {
    if (error instanceof ArgumentError) {
      ui.error(error.message);
      printCommandHelp(ui, command);
      return 2;
    }
    ui.error(
      `envs ${command.name} could not finish`,
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  };

  try {
    const outcome = command.run({
      ui,
      args: parseArgs(rest, command.options),
      env,
      cwd,
    });
    return outcome instanceof Promise ? outcome.catch(refuse) : outcome;
  } catch (error) {
    return refuse(error);
  }
}
