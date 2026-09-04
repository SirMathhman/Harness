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

/**
 * Build the full tool registry for a session (spec §3.3).
 * The background command manager is created per session (in-memory only).
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
  return { registry, manager };
}

export { ToolRegistry, dispatch, validateArgs } from "./registry.js";
export { executeToolCalls } from "./execute.js";
export { BackgroundCommandManager } from "./commands.js";
