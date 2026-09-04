#!/usr/bin/env node
import { parseCliArgs, resolveConfig, ConfigError } from "./config/index.js";
import { discoverModel } from "./llm/client.js";
import { startRepl } from "./cli/repl.js";
import { createHookManager, HookLoadError } from "./hooks/index.js";

/**
 * Harness entry point (spec §3.6).
 *
 * Parses CLI args, resolves + validates config, auto-discovers the model if
 * none was configured, loads the configured hook files, then starts the REPL.
 * Config errors and hook-loading errors produce clear, actionable messages and
 * a non-zero exit code (hooks spec §3.3).
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
    config = resolveConfig(flags, flags.config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Auto-discover the model from the running server when none was configured
  // (spec §6.1: model is optional when a server is already running).
  if (config.model === null) {
    config.model = await discoverModel(config.baseUrl, config.apiKey);
  }
  if (config.model === null) {
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

  // Hooks are loaded before the session exists, so `session:start` can fire
  // against the full set. A bad hook file is fatal (hooks spec §3.3).
  let hooks;
  try {
    hooks = await createHookManager(config.hooks);
  } catch (err) {
    if (err instanceof HookLoadError) {
      console.error(`Hook error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  await startRepl(config, initialTask, hooks);
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
      "  --hooks <path>         Hook file to load (repeatable)",
      "  -h, --help             Show this help",
      "",
      "Type 'exit' or 'quit' at the prompt to leave the REPL.",
    ].join("\n"),
  );
}

/**
 * The hooks API, re-exported so a hook file can write
 * `import type { Hook } from "harness"` (hooks spec §3.2).
 */
export type {
  Hook,
  HookContext,
  HookEvent,
  HookHandler,
  HookResult,
} from "./hooks/index.js";

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
