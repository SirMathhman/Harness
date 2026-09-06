#!/usr/bin/env bun
import { CliError, helpText, parseCliArgs } from "./cli/args.js";
import { c } from "./cli/color.js";
import { startRepl } from "./cli/repl.js";
import { prepareSession } from "./startup.js";

/** Load configuration, discover models, and start the single CLI session. */
async function main(): Promise<void> {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) return fail(err.message);
    throw err;
  }

  if (args.help) {
    console.log(helpText());
    return;
  }

  // The agent-server commands (GUI spec §3.1) have their own startup path.
  if (args.command === "serve" || args.command === "gui") {
    const { runServer } = await import("./server/entry.js");
    const { DEFAULT_GUI_PORT } = await import("./server/protocol.js");
    await runServer(args.port ?? DEFAULT_GUI_PORT, args.command === "gui");
    return;
  }

  const prepared = await prepareSession();
  if (!prepared.ok) return fail(prepared.error);
  const { graph, profile, lastModel, statePath } = prepared.session;

  await startRepl(graph, profile, statePath, lastModel, args.task);
}

function fail(message: string): void {
  console.error(c.red(message));
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(c.red(`Fatal: ${(err as Error).message}`));
    process.exitCode = 1;
  });
}
