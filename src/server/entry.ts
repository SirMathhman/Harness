#!/usr/bin/env bun
/**
 * The agent-server entry point (GUI spec §3.1).
 *
 * `vise serve` / `vise gui` load config, discover models, resolve the
 * starting profile, and start the `AgentServer`. Exits non-zero on the same
 * fatal conditions as the CLI. It never touches stdin and keeps running after
 * the browser disconnects.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c } from "../cli/color.js";
import {
  addDiscoveredModels,
  MissingMaxContextError,
  resolveProfile,
  resolveStartingProfile,
  stateFilePath,
  ViseConfigError,
  loadViseConfig,
  type DiscoveryResult,
  type ModelDef,
  type ResourceGraph,
} from "../profiles/index.js";
import { AgentServer } from "./server.js";
import { DEFAULT_GUI_PORT } from "./protocol.js";

/**
 * The `vise serve` / `vise gui` entry point (GUI spec §3.1).
 *
 * Loads config, discovers models, resolves the starting profile, and starts
 * the agent-server. Exits non-zero on the same fatal conditions as the CLI.
 */
export async function runServer(
  port: number,
  openBrowser: boolean,
): Promise<void> {
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
  try {
    resolveProfile(graph, starting.profile, {
      modelNameHint: starting.lastModel,
    });
  } catch (err) {
    if (err instanceof MissingMaxContextError) return fail(err.message);
    throw err;
  }

  // Locate the built UI assets (gui/dist), relative to this source file.
  // fileURLToPath handles Windows drive-letter paths correctly.
  const staticDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "gui",
    "dist",
  );

  const server = new AgentServer({
    graph,
    profile: starting.profile,
    lastModel: starting.lastModel,
    statePath,
    staticDir: existsSync(staticDir) ? staticDir : null,
  });

  const actualPort = await server.start(port);
  const url = `http://localhost:${actualPort}`;
  console.log(c.green(`Vise GUI: ${url}`));

  if (openBrowser) {
    try {
      await openInBrowser(url);
    } catch {
      // best-effort; the user can open the URL manually
    }
  }

  // Keep running until the process is stopped (GUI spec §4.1, §6.2).
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.stop().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

/** Open a URL in the default browser (best-effort, cross-platform). */
async function openInBrowser(url: string): Promise<void> {
  const args =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  await child.exited;
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
          `Provider "${provider.name}" threw during discovery: ${(err as Error).message}`,
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
  runServer(DEFAULT_GUI_PORT, false).catch((err) => {
    console.error(c.red(`Fatal: ${(err as Error).message}`));
    process.exitCode = 1;
  });
}