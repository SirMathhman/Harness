/**
 * The shared startup seam (GUI spec §3.1).
 *
 * Both the REPL (`src/cli.ts`) and the agent-server (`src/server/entry.ts`)
 * begin with the same prefix: load the resource graph, discover models, and
 * resolve the starting profile. This module owns that prefix and every fatal
 * condition in it, so the two entry points can never fork the config/state
 * logic. Each entry point calls `prepareSession` and then diverges only in its
 * terminal-specific tail (the REPL loop vs. the `AgentServer`).
 */
import { c } from "./cli/color.js";
import {
  addDiscoveredModels,
  IMPLICIT_PROFILE_NAME,
  resolveProfile,
  ViseConfigError,
  loadViseConfig,
  type DiscoveryResult,
  type ResourceGraph,
  type ModelDef,
} from "./profiles/index.js";

/** A successfully prepared session, ready for an entry point to run. */
export interface PreparedSession {
  graph: ResourceGraph;
  profile: string;
  /** The model the profile resolved to, or null when it has no usable model. */
  model: string | null;
}

/** The outcome of `prepareSession`: a prepared session or a fatal message. */
export type PrepareResult =
  | { ok: true; session: PreparedSession }
  | { ok: false; error: string };

/**
 * Load config, discover models, and resolve the starting profile.
 *
 * Returns `{ ok: false, error }` for any fatal startup condition (config error,
 * no provider, no models, unresolvable profile) so the caller can print it and
 * exit non-zero. Throws only for unexpected (non-fatal) errors.
 */
export async function prepareSession(): Promise<PrepareResult> {
  let graph: ResourceGraph;
  try {
    graph = await loadViseConfig();
  } catch (err) {
    if (err instanceof ViseConfigError)
      return { ok: false, error: err.message };
    throw err;
  }

  if (graph.providers.size === 0) {
    return { ok: false, error: noModelsMessage() };
  }

  const { results, totalDiscovered } = await discoverAllModels(graph);
  if (totalDiscovered === 0) {
    return { ok: false, error: noModelsMessage() };
  }

  graph = addDiscoveredModels(graph, results);
  // v0.8.0 removed the state file: a fresh start always begins at the built-in
  // `Agent` profile with normal model resolution (spec §3.5).
  const profile = IMPLICIT_PROFILE_NAME;
  const resolved = resolveProfile(graph, profile);
  if (resolved.config.model === null) {
    return {
      ok: false,
      error:
        `Profile '${profile}' has no available models.\n` +
        "Connect a Model resource to it in ./.vise/index.ts, or make sure a " +
        "registered provider can reach its server.\n",
    };
  }

  return {
    ok: true,
    session: {
      graph,
      profile,
      model: resolved.config.model,
    },
  };
}

/** The shared "no models" fatal message (providers spec §3.11). */
function noModelsMessage(): string {
  return (
    "No models available. Register a provider in .vise/index.ts (e.g., " +
    "reg.addProvider(new LlamaProvider({ url: 'http://localhost:8080' })))."
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
