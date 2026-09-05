import { parseArgs } from "node:util";

/** Errors raised for an unusable command line. */
export class CliError extends Error {}

/** The top-level command the CLI runs. */
export type CliCommand = "repl" | "serve" | "gui";

/** The parsed command line. Vise takes a task and almost nothing else. */
export interface CliArgs {
  /** True when `-h` / `--help` was passed. */
  help: boolean;
  /** The top-level command. Defaults to the interactive REPL. */
  command: CliCommand;
  /** The port for `serve`/`gui`, or null to use the default (8787). */
  port: number | null;
  /** The task to run as the first turn, or null for a bare REPL. */
  task: string | null;
}

/**
 * Parse the command line (profiles spec §8; GUI spec §3.1).
 *
 * All agent configuration lives in `./.vise/index.ts`, so there are no
 * configuration flags: the command line carries a task and `--help`. The
 * `serve` and `gui` subcommands start the agent-server (GUI spec §3.1) and
 * accept `--port`. Any other option is rejected with a message pointing at the
 * config file, rather than being silently ignored.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
    },
  });

  const unknown = Object.keys(values).filter(
    (k) => k !== "help" && k !== "h" && k !== "port",
  );
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown option(s): ${unknown.map((k) => `--${k}`).join(", ")}. ` +
        `Vise is configured entirely from ./.vise/index.ts; run \`vise --help\` ` +
        `for the options it does take.`,
    );
  }

  // A leading `serve` or `gui` positional selects the agent-server command;
  // any other positional is the task for the REPL.
  let command: CliCommand = "repl";
  let taskPositionals = positionals;
  if (positionals[0] === "serve" || positionals[0] === "gui") {
    command = positionals[0];
    taskPositionals = positionals.slice(1);
  }

  let port: number | null = null;
  if (values.port !== undefined) {
    const parsed = Number(values.port);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new CliError(`Invalid --port: ${values.port}`);
    }
    port = parsed;
  }

  return {
    help: values.help === true,
    command,
    port,
    task: taskPositionals.join(" ").trim() || null,
  };
}

/** The text shown by `vise --help`. */
export function helpText(): string {
  return [
    "vise — a local LLM coding agent",
    "",
    "Usage: vise [task] [options]",
    "       vise serve [--port <n>]",
    "       vise gui [--port <n>]",
    "",
    "Commands:",
    "  (none)     Run the interactive REPL (optionally with a first task).",
    "  serve      Start the agent-server (headless) and print its URL.",
    "  gui        Start the agent-server and open it in the browser.",
    "",
    "Options:",
    "  -h, --help        Show this help",
    "  --port <n>        Port for serve/gui (default 8787)",
    "",
    "Configuration lives in ./.vise/index.ts, which default-exports a",
    "function (reg: Registry) => void describing profiles, hooks, tools,",
    "and models. With no such file, Vise runs with built-in defaults.",
    "",
    "In the REPL: /help lists the commands, /profile switches profiles.",
    "Type 'exit' or 'quit' at the prompt to leave the REPL.",
  ].join("\n");
}
