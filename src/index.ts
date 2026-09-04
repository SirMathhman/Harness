#!/usr/bin/env node
import {
  parseCliArgs,
  resolveConfig,
  ConfigError,
  ModelNotConfiguredError,
} from "./config/index.js";
import { startRepl } from "./cli/repl.js";

/**
 * Harness entry point (spec §3.6).
 *
 * Parses CLI args, resolves + validates config, then starts the REPL.
 * Config errors produce clear, actionable messages and a non-zero exit code.
 */
async function main(): Promise<void> {
  const { flags, positionals } = parseCliArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return;
  }

  // A single task may be passed positionally; it is run as the first turn.
  const initialTask = positionals.join(" ").trim() || null;

  let config;
  try {
    config = await resolveConfig(flags, flags.config);
  } catch (err) {
    if (err instanceof ModelNotConfiguredError) {
      console.error(
        "No model could be resolved.\n" +
          "The harness looks for a model in this order:\n" +
          "  1. the --model flag\n" +
          "  2. the HARNESS_MODEL environment variable\n" +
          "  3. a harness.config.json file (see README)\n" +
          "  4. auto-discovery from the running server's /v1/models\n" +
          "None of these yielded a model. Start a llama.cpp server with a model\n" +
          "loaded, or set one explicitly.\n",
      );
      process.exitCode = 1;
      return;
    }
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  await startRepl(config, initialTask);
}

function printHelp(): void {
  console.log(
    [
      "harness — a local LLM coding agent",
      "",
      "Usage: harness [task] [options]",
      "",
      "Options:",
      "  --config <path>        Path to a config file (default ./harness.config.json)",
      "  --model <name>         Model name (default: auto-discovered from the running server)",
      "  --base-url <url>       LLM server base URL (default http://localhost:8080)",
      "  --temperature <n>      Sampling temperature (default 0.2)",
      "  --max-context <n>      Context window size in tokens (default 8192)",
      "  --max-iterations <n>   Cap on tool-call iterations per turn",
      "  -h, --help             Show this help",
      "",
      "Type 'exit' or 'quit' at the prompt to leave the REPL.",
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
