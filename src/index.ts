#!/usr/bin/env node
import { CliError, helpText, parseCliArgs } from "./cli/args.js";
import { startRepl } from "./cli/repl.js";
import { discoverModel } from "./llm/client.js";
import {
  defaultProfileName,
  loadViseConfig,
  resolveProfile,
  ViseConfigError,
  withDiscoveredModel,
  type ResourceGraph,
} from "./profiles/index.js";

/**
 * Vise entry point (profiles spec §3.10).
 *
 * Parses the command line, loads `./.vise/index.ts` into a resource graph,
 * auto-discovers a model when the default model has none, then starts the
 * REPL under the graph's default profile. A bad config is fatal, with a
 * message naming the problem and a non-zero exit code (§4).
 */
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

  let graph: ResourceGraph;
  try {
    graph = await loadViseConfig();
  } catch (err) {
    if (err instanceof ViseConfigError) return fail(err.message);
    throw err;
  }

  graph = await resolveDefaultModel(graph);

  // A profile with no usable model cannot run (§3.11). The check is here, not
  // in validation, because it depends on what the running server reports.
  const startingProfile = defaultProfileName(graph);
  if (resolveProfile(graph, startingProfile).config.model === null) {
    return fail(
      "No model could be resolved.\n" +
        "Vise takes the model from the Model resource connected to the active\n" +
        "profile, and otherwise auto-discovers one from the running server's\n" +
        "/v1/models. Neither yielded a model. Start a llama.cpp server with a\n" +
        "model loaded, or declare one in ./.vise/index.ts:\n" +
        "\n" +
        "  const model = reg.createModel({\n" +
        '    name: "my-model",\n' +
        '    baseUrl: "http://localhost:8080",\n' +
        '    apiKey: "",\n' +
        "  });\n" +
        "  reg.createConnection(profile, model);\n",
    );
  }

  await startRepl(graph, args.task);
}

/**
 * Fill in the starting profile's model name from the running server when the
 * config left it blank (spec §3.10). A Model resource that names its model
 * explicitly is left alone, and so is discovery for other profiles: they are
 * resolved on demand by `/profile`.
 */
async function resolveDefaultModel(
  graph: ResourceGraph,
): Promise<ResourceGraph> {
  const resolved = resolveProfile(graph, defaultProfileName(graph));
  if (resolved.config.model !== null) return graph;
  const discovered = await discoverModel(
    resolved.config.baseUrl,
    resolved.config.apiKey,
  );
  return discovered === null
    ? graph
    : withDiscoveredModel(graph, resolved.modelId, discovered);
}

/** Report a fatal startup problem and set a non-zero exit code. */
function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

/**
 * The public configuration API, re-exported so `.vise/index.ts` can write
 * `import type { Registry } from "vise"` (profiles spec §3.1).
 */
export type {
  HookDef,
  ModelDef,
  ProfileDef,
  ProfileSwitchMode,
  Registry,
  ResourceId,
  RuntimeSettings,
  SubagentPolicy,
  ToolDef,
  ViseConfig,
} from "./profiles/index.js";

/**
 * The hooks API, re-exported so a hook can be written against
 * `import type { Hook } from "vise"` (hooks spec §3.2).
 */
export type {
  Hook,
  HookContext,
  HookEvent,
  HookHandler,
  HookResult,
} from "./hooks/index.js";

/** The tool API, for custom tools created with `reg.createTool()`. */
export type { JsonSchema, JsonSchemaProperty, Tool } from "./types.js";

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
