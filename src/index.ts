#!/usr/bin/env node
import { CliError, helpText, parseCliArgs } from "./cli/args.js";
import { startRepl } from "./cli/repl.js";
import { discoverModel } from "./llm/client.js";
import {
  resolveProfile,
  resolveStartingProfile,
  stateFilePath,
  ViseConfigError,
  withDiscoveredModel,
  loadViseConfig,
  type ResourceGraph,
  type StartingProfile,
} from "./profiles/index.js";

/**
 * Vise entry point (config spec §3.10).
 *
 * Parses the command line, loads `~/.vise/index.ts` and `./.vise/index.ts`
 * into a combined resource graph, resolves the starting profile from the
 * state file (§3.7), auto-discovers a model when needed, then starts the REPL
 * under that profile. A bad config is fatal, with a message naming the
 * problem and a non-zero exit code (§4).
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

  const statePath = stateFilePath();
  const starting = resolveStartingProfile(graph, statePath);

  graph = await resolveStartingModel(graph, starting);

  // A profile with no usable model cannot run (§3.11). The check is here, not
  // in validation, because it depends on what the running server reports.
  if (resolveProfile(graph, starting.profile).config.model === null) {
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

  await startRepl(graph, starting.profile, statePath, args.task);
}

/**
 * Fill in the starting profile's model name when the config left it blank
 * (config spec §3.8.4). The saved `lastModel` wins when there is one — it
 * pins the model across a restart even if the server's model list changes —
 * otherwise Vise auto-discovers from the running server's `/v1/models`. A
 * Model resource that names its model explicitly is left alone, and so is
 * discovery for other profiles: they are resolved on demand by `/profile`.
 */
async function resolveStartingModel(
  graph: ResourceGraph,
  starting: StartingProfile,
): Promise<ResourceGraph> {
  const resolved = resolveProfile(graph, starting.profile);
  if (resolved.config.model !== null) return graph;
  if (starting.lastModel !== null) {
    return withDiscoveredModel(graph, resolved.modelId, starting.lastModel);
  }
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
