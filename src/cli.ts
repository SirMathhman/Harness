#!/usr/bin/env bun
import { CliError, helpText, parseCliArgs } from "./cli/args.js";
import { c } from "./cli/color.js";
import { startRepl } from "./cli/repl.js";
import {
  addDiscoveredModels,
  MissingMaxContextError,
  resolveProfile,
  resolveStartingProfile,
  stateFilePath,
  ViseConfigError,
  loadViseConfig,
  type DiscoveryResult,
  type ResourceGraph,
  type ModelDef,
} from "./profiles/index.js";

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

  let graph: ResourceGraph;
  try {
    graph = await loadViseConfig();
  } catch (err) {
    if (err instanceof ViseConfigError) return fail(err.message);
    throw err;
  }

  if (graph.providers.size === 0) {
    return fail(
      "No models available. Register a provider in .vise/index.ts (e.g., " +
        "reg.addProvider(new LlamaProvider({ url: 'http://localhost:8080' }))).",
    );
  }

  const { results, totalDiscovered } = await discoverAllModels(graph);
  if (totalDiscovered === 0) {
    return fail(
      "No models available. Register a provider in .vise/index.ts (e.g., " +
        "reg.addProvider(new LlamaProvider({ url: 'http://localhost:8080' }))).",
    );
  }

  graph = addDiscoveredModels(graph, results);
  const statePath = stateFilePath();
  const starting = resolveStartingProfile(graph, statePath);
  let startingResolved;
  try {
    startingResolved = resolveProfile(graph, starting.profile, {
      modelNameHint: starting.lastModel,
    });
  } catch (err) {
    if (err instanceof MissingMaxContextError) return fail(err.message);
    throw err;
  }
  if (startingResolved.config.model === null) {
    return fail(
      `Profile '${starting.profile}' has no available models.\n` +
        "Connect a Model resource to it in ./.vise/index.ts, or make sure a " +
        "registered provider can reach its server.\n",
    );
  }

  await startRepl(
    graph,
    starting.profile,
    statePath,
    starting.lastModel,
    args.task,
  );
}

/** Discover providers sequentially; failed discovery warns and continues. */
async function discoverAllModels(
  graph: ResourceGraph,
): Promise<{ results: DiscoveryResult[]; totalDiscovered: number }> {
  const results: DiscoveryResult[] = [];
  let totalDiscovered = 0;

  for (const [providerId, provider] of graph.providers) {
    let models: ModelDef[];
    try {
      models = await provider.discoverModels();
    } catch (err) {
      console.error(
        c.yellow(
          `Provider "${provider.name}" threw during discovery: ` +
            `${(err as Error).message}`,
        ),
      );
      models = [];
    }
    if (models.length === 0) {
      const url = (provider as { baseUrl?: unknown }).baseUrl;
      const label =
        typeof url === "string"
          ? `'${provider.name}' (${url})`
          : `'${provider.name}'`;
      console.error(
        c.yellow(
          `Provider ${label} returned no models. Is the server running?`,
        ),
      );
    }
    results.push({ providerId, models });
    totalDiscovered += models.length;
  }

  return { results, totalDiscovered };
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
