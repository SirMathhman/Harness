import type { Config, Tool } from "../types.js";
import { BackgroundCommandManager } from "./commands.js";
import { makeCheckCommandTool, makeRunCommandTool } from "./commands.js";
import {
  editFileTool,
  listDirTool,
  readFileTool,
  writeFileTool,
} from "./fileTools.js";
import { finishTool } from "./finish.js";
import { searchTool } from "./search.js";
import { ToolRegistry } from "./registry.js";
import {
  CORE_TOOL_NAMES,
  makeCallToolTool,
  makeSearchToolsTool,
} from "./metaTools.js";

/** Which tools a session's registry should hold (profiles spec §3.5 rule 2). */
export interface ToolSelection {
  /**
   * Built-in tools to register. `null` (the default) registers all of them,
   * which is what a profile with no Profile→Tool edges gets.
   */
  builtins?: string[] | null;
  /**
   * Custom tools from the resource graph. Only ever the ones explicitly
   * connected to the active profile.
   */
  custom?: Tool[];
}

/**
 * Build the tool registry for a session (spec §3.3).
 * The background command manager is created per session (in-memory only).
 *
 * `selection` narrows the built-in set to the active profile's Profile→Tool
 * edges and adds its custom tools. `spawn_subagent` is *not* built here: it
 * needs a runner, so the agent layer registers it (see `agent/session.ts`).
 *
 * When `config.dynamicTools` is set, the registry advertises only a constant
 * surface (the core tools it actually has, plus `search_tools` and
 * `call_tool`) while the full catalog stays reachable through `call_tool`
 * (spec §3.3.1).
 */
export function buildToolRegistry(
  config: Config,
  selection: ToolSelection = {},
): {
  registry: ToolRegistry;
  manager: BackgroundCommandManager;
} {
  const manager = new BackgroundCommandManager();
  const registry = new ToolRegistry();
  const allowed = selection.builtins ?? null;
  const wanted = (name: string) => allowed === null || allowed.includes(name);

  const builtins: Tool[] = [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    searchTool,
    makeRunCommandTool(
      manager,
      config.commandTimeoutMs,
      config.shell,
      config.maxToolOutputChars,
    ),
    makeCheckCommandTool(manager, config.maxToolOutputChars),
    finishTool,
  ];
  for (const tool of builtins) {
    if (wanted(tool.name)) registry.register(tool);
  }
  for (const tool of selection.custom ?? []) {
    registry.register(tool);
  }

  if (config.dynamicTools) {
    // Only advertise the core tools this profile actually has; the rest of its
    // catalog stays reachable through call_tool.
    const core = CORE_TOOL_NAMES.filter((name) => registry.get(name));
    registry
      .register(makeSearchToolsTool(registry))
      .register(makeCallToolTool(registry, config.maxToolOutputChars))
      .setAdvertised([...core, "search_tools", "call_tool"]);
  }

  return { registry, manager };
}

export { ToolRegistry, dispatch, validateArgs } from "./registry.js";
export { executeToolCalls, type ToolLifecycle } from "./execute.js";
export { BackgroundCommandManager } from "./commands.js";
export { BUILTIN_TOOL_NAMES, FINISH_TOOL_NAME } from "./names.js";
