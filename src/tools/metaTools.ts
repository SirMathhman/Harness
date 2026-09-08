import type { Tool } from "../types.js";
import { ToolRegistry, dispatch } from "./registry.js";
import { searchCatalog } from "./catalog.js";

/**
 * The constant, always-advertised tool surface used in dynamic mode
 * (spec §3.3.1). Core tools are advertised directly so the model can use them
 * without a discovery round-trip; the long tail is reached via
 * `search_tools` + `call_tool`.
 */
export const CORE_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "search",
  "finish",
  // The skill tools are constant-surface too (skills spec §3.4, §3.5): the
  // index in the system prompt is useless if loading a skill needs a
  // `search_tools` round-trip first.
  "list_skills",
  "read_skill",
  // An interactive tool should not require a `search_tools` round-trip to
  // discover (v0.7.0 spec §2.4).
  "ask_questions",
] as const;

/**
 * search_tools (spec §3.3.1).
 *
 * Searches the full tool catalog and returns the matching tool definitions
 * (name, description, parameters) as a JSON string. The model reads these
 * in-context and then invokes the tool via `call_tool`. This keeps the
 * advertised `tools` array constant so the request prefix stays stable for
 * KV-cache reuse.
 */
export function makeSearchToolsTool(registry: ToolRegistry): Tool {
  return {
    name: "search_tools",
    mutating: false,
    description:
      "Search the available tool catalog. Returns matching tool definitions " +
      "(name, description, parameters) as JSON. Use call_tool to invoke one.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What you want to do (matched against tool names/descriptions).",
        },
        limit: {
          type: "integer",
          description: "Maximum number of results (default 5).",
        },
      },
      required: ["query"],
    },
    async handler(args) {
      const query = String(args.query ?? "");
      const limit =
        typeof args.limit === "number" && args.limit > 0
          ? Math.floor(args.limit)
          : 5;
      const matches = searchCatalog(registry.all(), query, limit);
      if (matches.length === 0) {
        return "No tools matched. Try a different query.";
      }
      const defs = matches.map((m) => m.tool);
      return JSON.stringify(defs, null, 2);
    },
  };
}

/**
 * call_tool (spec §3.3.1).
 *
 * A single, fixed-schema dispatcher. Routes `name` + `args` to the existing
 * `dispatch`, which validates arguments and returns errors as result strings.
 * This is the only way to invoke long-tail tools in dynamic mode.
 */
export function makeCallToolTool(
  registry: ToolRegistry,
  maxToolOutputChars: number,
): Tool {
  return {
    name: "call_tool",
    mutating: true,
    description:
      "Invoke a tool by name with its arguments. Use search_tools first to " +
      "discover a tool's name and parameter schema.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The tool name to invoke.",
        },
        args: {
          type: "object",
          description: "The tool's arguments as a JSON object.",
        },
      },
      required: ["name", "args"],
    },
    async handler(args) {
      const name = String(args.name ?? "");
      const toolArgs =
        typeof args.args === "object" && args.args !== null
          ? (args.args as Record<string, unknown>)
          : {};
      const result = await dispatch(
        registry,
        { id: "call_tool", name, arguments: toolArgs },
        maxToolOutputChars,
      );
      return result.content;
    },
  };
}
