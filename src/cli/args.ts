import { parseArgs } from "node:util";

/** Errors raised for an unusable command line. */
export class CliError extends Error {}

/** The parsed command line. Vise takes a task and almost nothing else. */
export interface CliArgs {
  /** True when `-h` / `--help` was passed. */
  help: boolean;
  /** The task to run as the first turn, or null for a bare REPL. */
  task: string | null;
}

/**
 * Parse the command line (profiles spec §8).
 *
 * All agent configuration lives in `./.vise/index.ts`, so there are no
 * configuration flags: the command line carries a task and `--help`. Any other
 * option is rejected with a message pointing at the config file, rather than
 * being silently ignored.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: { help: { type: "boolean", short: "h" } },
  });

  const unknown = Object.keys(values).filter((k) => k !== "help" && k !== "h");
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown option(s): ${unknown.map((k) => `--${k}`).join(", ")}. ` +
        `Vise is configured entirely from ./.vise/index.ts; run \`vise --help\` ` +
        `for the options it does take.`,
    );
  }

  return {
    help: values.help === true,
    task: positionals.join(" ").trim() || null,
  };
}

/** The text shown by `vise --help`. */
export function helpText(): string {
  return [
    "vise — a local LLM coding agent",
    "",
    "Usage: vise [task] [options]",
    "",
    "Options:",
    "  -h, --help   Show this help",
    "",
    "Configuration lives in ./.vise/index.ts, which default-exports a",
    "function (reg: Registry) => void describing profiles, hooks, tools,",
    "and models. With no such file, Vise runs with built-in defaults.",
    "",
    "In the REPL: /help lists the commands, /profile switches profiles.",
    "Type 'exit' or 'quit' at the prompt to leave the REPL.",
  ].join("\n");
}
