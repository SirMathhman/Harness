import type { Config } from "../types.js";
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

/**
 * Build the full tool registry for a session (spec §3.3).
 * The background command manager is created per session (in-memory only).
 *
 * When `config.dynamicTools` is set, the registry advertises only a constant
 * surface (core tools + search_tools + call_tool) while the full catalog stays
 * reachable through call_tool (spec §3.3.1).
 */
export function buildToolRegistry(config: Config): {
  registry: ToolRegistry;
  manager: BackgroundCommandManager;
} {
  const manager = new BackgroundCommandManager();
  const registry = new ToolRegistry();
  registry
    .register(readFileTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(listDirTool)
    .register(searchTool)
    .register(
      makeRunCommandTool(
        manager,
        config.commandTimeoutMs,
        config.shell,
        config.maxToolOutputChars,
      ),
    )
    .register(makeCheckCommandTool(manager, config.maxToolOutputChars))
    .register(finishTool);

  if (config.dynamicTools) {
    registry
      .register(makeSearchToolsTool(registry))
      .register(makeCallToolTool(registry, config.maxToolOutputChars))
      .setAdvertised([...CORE_TOOL_NAMES, "search_tools", "call_tool"]);
  }

  return { registry, manager };
}

export { ToolRegistry, dispatch, validateArgs } from "./registry.js";
export { executeToolCalls } from "./execute.js";
export { BackgroundCommandManager } from "./commands.js";
